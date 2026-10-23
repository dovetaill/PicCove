use super::*;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Init {
    Systemd,
    OpenRc,
}

impl Init {
    fn detect(systemd: bool, openrc: bool) -> Result<Self> {
        match (systemd, openrc) {
            (true, _) => Ok(Self::Systemd),
            (_, true) => Ok(Self::OpenRc),
            _ => bail!("未检测到运行中的 systemd 或 OpenRC，无法自动启用宿主机管理服务"),
        }
    }

    fn definition(self, root: &Path) -> Result<String> {
        let root = root.to_str().context("安装目录必须为 UTF-8")?;
        ensure!(
            !root.chars().any(char::is_control),
            "安装目录不能含控制字符"
        );
        if root == "/opt/piccove" {
            return Ok(match self {
                Self::Systemd => include_str!("../../../../deploy/piccove-web-manager.service"),
                Self::OpenRc => include_str!("../../../../deploy/piccove-web-manager.openrc"),
            }
            .into());
        }
        let binary = format!("{root}/bin/piccovectl");
        Ok(match self {
            Self::Systemd => include_str!("../../../../deploy/piccove-web-manager.service")
                .replace(
                    "ExecStart=/opt/piccove/bin/piccovectl web-manager --directory /opt/piccove",
                    &format!(
                        "ExecStart={} web-manager --directory {}",
                        systemd_quote(&binary),
                        // Only arguments undergo environment expansion; the executable path does not.
                        systemd_quote(root).replace('$', "$$")
                    ),
                ),
            Self::OpenRc => include_str!("../../../../deploy/piccove-web-manager.openrc")
                // OpenRC evaluates command and command_args after sourcing the script.
                .replace(
                    "command=/opt/piccove/bin/piccovectl",
                    &format!("command={}", shell_quote(&shell_quote(&binary))),
                )
                .replace(
                    "command_args=\"web-manager --directory /opt/piccove\"",
                    &format!(
                        "command_args={}",
                        shell_quote(&format!("web-manager --directory {}", shell_quote(root)))
                    ),
                ),
        })
    }

    fn commands(self, name: &str) -> Vec<Vec<String>> {
        let commands = match self {
            Self::Systemd => vec![
                vec!["systemctl", "daemon-reload"],
                vec!["systemctl", "enable", "--now", name],
            ],
            Self::OpenRc => vec![
                vec!["rc-update", "add", name, "default"],
                vec!["rc-service", "--ifstopped", name, "start"],
            ],
        };
        commands
            .into_iter()
            .map(|c| c.into_iter().map(str::to_string).collect())
            .collect()
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn systemd_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    )
}

fn name(root: &Path) -> String {
    if root == Path::new("/opt/piccove") {
        "piccove-web-manager".into()
    } else {
        format!(
            "piccove-web-manager-{:x}",
            Sha256::digest(root.as_os_str().as_encoded_bytes())
        )
    }
}

fn check_existing(path: &Path, content: &str) -> Result<()> {
    ordinary(path)?;
    if path.exists() {
        let meta = fs::metadata(path)?;
        ensure!(
            meta.is_file() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o022 == 0,
            "服务配置不是安全的普通文件：{}",
            path.display()
        );
        ensure!(
            fs::read_to_string(path)? == content,
            "已有服务配置与本实例不一致，请先核对，未覆盖：{}",
            path.display()
        );
    }
    Ok(())
}

pub(super) struct Service {
    init: Init,
    name: String,
    path: PathBuf,
    content: String,
}

impl Service {
    pub(super) fn prepare(root: &Path) -> Result<Self> {
        ensure!(
            unsafe { libc::geteuid() } == 0,
            "安装和升级需要 root，以注册宿主机管理服务"
        );
        let init = Init::detect(
            Path::new("/run/systemd/system").is_dir(),
            Path::new("/run/openrc/softlevel").exists() && Path::new("/sbin/openrc-run").is_file(),
        )?;
        let name = name(root);
        let (name, path) = match init {
            Init::Systemd => {
                let unit = format!("{name}.service");
                // Do not shadow a unit supplied by the operator or a distribution.
                for directory in [
                    "/run/systemd/system",
                    "/usr/lib/systemd/system",
                    "/lib/systemd/system",
                ] {
                    ensure!(
                        !Path::new(directory).join(&unit).try_exists()?,
                        "已有服务定义：{directory}/{unit}，请先核对"
                    );
                }
                (unit.clone(), Path::new("/etc/systemd/system").join(unit))
            }
            Init::OpenRc => (name.clone(), Path::new("/etc/init.d").join(name)),
        };
        let content = init.definition(root)?;
        check_existing(&path, &content)?;
        Ok(Self {
            init,
            name,
            path,
            content,
        })
    }

    pub(super) fn enable(self, rt: &Runtime) -> Result<()> {
        check_existing(&self.path, &self.content)?;
        if !self.path.exists() {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(if self.init == Init::OpenRc {
                    0o755
                } else {
                    0o644
                })
                .open(&self.path)?;
            file.write_all(self.content.as_bytes())?;
            file.sync_all()?;
        }
        // Starting an active service is a no-op; restarting would kill a Web-initiated update.
        for command in self.init.commands(&self.name) {
            rt.command(Command::new(&command[0]).args(&command[1..]), None, 120)?;
        }
        println!("宿主机管理服务已配置开机启动：{}", self.name);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_running_init_and_never_restarts_manager() {
        assert_eq!(Init::detect(true, false).unwrap(), Init::Systemd);
        assert_eq!(Init::detect(false, true).unwrap(), Init::OpenRc);
        assert!(Init::detect(false, false).is_err());
        assert_eq!(
            Init::Systemd.commands("test.service")[1],
            ["systemctl", "enable", "--now", "test.service"]
        );
        assert_eq!(
            Init::OpenRc.commands("test")[1],
            ["rc-service", "--ifstopped", "test", "start"]
        );
        assert_ne!(name(Path::new("/opt/one")), name(Path::new("/opt/two")));
    }

    #[test]
    fn renders_paths_without_shell_or_systemd_expansion() {
        let dollar_path = Init::Systemd.definition(Path::new("/opt/$data")).unwrap();
        assert!(dollar_path.contains(
            "ExecStart=\"/opt/$data/bin/piccovectl\" web-manager --directory \"/opt/$$data\""
        ));
        let root = "/opt/a b'\"\\$HOME%name;$(false)";
        let definition = Init::Systemd.definition(Path::new(root)).unwrap();
        assert!(definition.contains("$$HOME%%name;$$(false)"));
        assert!(definition.contains("\\\"\\\\"));
        let definition = Init::OpenRc.definition(Path::new(root)).unwrap();
        let output = Command::new("/bin/sh").env_clear().arg("-c").arg(format!("{definition}\neval 'set -- ' \"$command\" \"$command_args\"\nprintf '%s\\n' \"$@\"\n")).output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{root}/bin/piccovectl\nweb-manager\n--directory\n{root}\n")
        );
        assert!(Init::OpenRc.definition(Path::new("/opt/a\nb")).is_err());
    }

    #[test]
    fn preserves_existing_files_and_rejects_conflicts_and_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("service");
        check_existing(&file, "ours").unwrap();
        fs::write(&file, "ours").unwrap();
        check_existing(&file, "ours").unwrap();
        assert!(check_existing(&file, "other").is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "ours");
        let link = dir.path().join("link");
        symlink(&file, &link).unwrap();
        assert!(check_existing(&link, "ours").is_err());
    }
}
