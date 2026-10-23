use super::*;
use std::io::{BufRead, BufReader};
use std::os::unix::net::UnixListener;

fn allowed(action: &str) -> bool {
    matches!(action, "status" | "update" | "restart")
}

fn save(root: &Path, value: &Value) -> Result<()> {
    let path = root.join(".piccove-web-operation.json");
    ordinary(&path)?;
    let mut file = tempfile::NamedTempFile::new_in(root)?;
    serde_json::to_writer(&mut file, value)?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    Ok(())
}

pub(super) fn run(rt: &Runtime, root: &Path) -> Result<()> {
    ensure!(
        unsafe { libc::geteuid() } == 0,
        "web-manager 需要宿主机 root 以执行现有容器升级流程"
    );
    config(rt, root)?;
    let id = rt.compose(root, &["ps", "-q", "api"], None)?;
    ensure!(id.lines().count() == 1, "请先启动唯一的 API 容器");
    let inspect: Value = serde_json::from_str(&rt.docker(&["inspect", id.trim()])?)?;
    let user = inspect[0]["Config"]["User"]
        .as_str()
        .context("API 缺少运行身份")?;
    let (uid, gid) = user
        .split_once(':')
        .context("API 必须使用明确的数值 UID:GID")?;
    let uid: u32 = uid.parse()?;
    let gid: u32 = gid.parse()?;
    ensure!(uid != 0 && gid != 0, "API 不得以 root 运行");
    let mount = inspect[0]["Mounts"]
        .as_array()
        .context("缺少挂载")?
        .iter()
        .find(|m| m["Destination"] == "/run/piccove" && m["RW"] == false)
        .context("API 缺少只读 /run/piccove 控制卷")?;
    let directory = PathBuf::from(mount["Source"].as_str().context("缺少挂载源")?);
    ordinary(&directory)?;
    if !directory.exists() {
        std::os::unix::fs::DirBuilderExt::mode(&mut fs::DirBuilder::new(), 0o755)
            .create(&directory)?;
    }
    let meta = fs::metadata(&directory)?;
    ensure!(
        meta.uid() == 0 && meta.mode() & 0o022 == 0,
        "控制目录必须属于 root 且其他用户不可写；不会自动修改现有权限"
    );
    let guard = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(directory.join("manager.lock"))?;
    fs2::FileExt::try_lock_exclusive(&guard).context("管理服务已运行")?;
    let socket = directory.join("control.sock");
    ordinary(&socket)?;
    if socket.exists() {
        use std::os::unix::fs::FileTypeExt;
        let meta = fs::symlink_metadata(&socket)?;
        ensure!(
            meta.file_type().is_socket() && meta.uid() == 0,
            "控制路径不是本服务的 socket"
        );
        fs::remove_file(&socket)?;
    }
    let listener = UnixListener::bind(&socket)?;
    let socket_meta = fs::metadata(&socket)?;
    let outcome = (|| -> Result<()> {
        let name = std::ffi::CString::new(socket.as_os_str().as_encoded_bytes())?;
        ensure!(
            unsafe { libc::chown(name.as_ptr(), 0, gid) } == 0,
            "无法设置新建 socket 的组"
        );
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o660))?;
        listener.set_nonblocking(true)?;
        let status_path = root.join(".piccove-web-operation.json");
        ordinary(&status_path)?;
        let mut status = if status_path.exists() {
            serde_json::from_slice::<Value>(&fs::read(status_path)?)?
        } else {
            json!({"state":"idle"})
        };
        if status["state"] == "running" {
            status = json!({"state":"failed","message":"管理进程曾中断，请检查升级记录及服务日志后再操作"});
            save(root, &status)?;
        }
        let mut job: Option<std::thread::JoinHandle<Result<()>>> = None;
        let result = (|| -> Result<()> {
            while !rt.cancelled.load(Ordering::Relaxed) {
                if job.as_ref().is_some_and(|j| j.is_finished()) {
                    let result = job
                        .take()
                        .unwrap()
                        .join()
                        .map_err(|_| anyhow::anyhow!("管理任务异常退出"))
                        .and_then(|r| r);
                    status["state"] = if result.is_ok() {
                        "succeeded"
                    } else {
                        "failed"
                    }
                    .into();
                    status["message"] = if result.is_ok() {
                        "操作完成"
                    } else {
                        "操作失败，请检查管理服务日志；升级失败不会自动回退"
                    }
                    .into();
                    if let Err(error) = result {
                        eprintln!("Web 操作失败：{error:#}");
                    }
                    save(root, &status)?;
                }
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                    Err(e) => return Err(e.into()),
                };
                stream.set_read_timeout(Some(Duration::from_secs(2)))?;
                stream.set_write_timeout(Some(Duration::from_secs(2)))?;
                let mut request = String::new();
                if BufReader::new((&stream).take(32))
                    .read_line(&mut request)
                    .is_err()
                {
                    continue;
                }
                let action = request.strip_suffix('\n').unwrap_or("");
                let response = if !allowed(action) {
                    json!({"error":"不支持的操作"})
                } else if action == "status" {
                    status.clone()
                } else if job.is_some() {
                    json!({"error":"已有升级或重启任务正在执行"})
                } else {
                    status = json!({"state":"running","action":action,"started_at":chrono::Utc::now(),"message":"正在执行，请等待服务恢复"});
                    save(root, &status)?;
                    let root = root.to_path_buf();
                    let action = action.to_string();
                    let runtime = Runtime {
                        cancelled: rt.cancelled.clone(),
                    };
                    job = Some(std::thread::spawn(move || {
                        runtime.command(
                            Command::new(root.join("bin/piccovectl"))
                                .arg(action)
                                .arg("--directory")
                                .arg(&root)
                                .arg("--non-interactive"),
                            None,
                            3600,
                        )?;
                        health(&runtime, &root)
                    }));
                    status.clone()
                };
                let _ = serde_json::to_writer(&mut stream, &response);
            }
            Ok(())
        })();
        rt.cancelled.store(true, Ordering::Relaxed);
        if let Some(job) = job {
            let _ = job.join();
        }
        result
    })();
    drop(listener);
    if let Ok(meta) = fs::symlink_metadata(&socket) {
        if meta.ino() == socket_meta.ino() && meta.dev() == socket_meta.dev() {
            fs::remove_file(socket)?;
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn web_commands_are_fixed() {
        for command in ["status", "update", "restart"] {
            assert!(allowed(command));
        }
        for command in [
            "stop",
            "install",
            "update --archive /tmp/x",
            "restart;sh",
            "../update",
            "",
        ] {
            assert!(!allowed(command));
        }
    }
}
