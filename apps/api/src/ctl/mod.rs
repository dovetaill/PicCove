use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::{
        fs::{symlink, MetadataExt, OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const REPO: &str = "https://github.com/dovetaill/PicCove";
const TARGET: &str = "x86_64-unknown-linux-musl";
// Only remove byte-identical v0.1.3 runtime scripts when migrating an unmanifested installation.
const LEGACY_FILES: [(&str, &str); 2] = [
    (
        "scripts/manage.py",
        "ce28685daca19af3440c45723a5c573be386f98bec807e94a2333254482e5ff9",
    ),
    (
        "configure.py",
        "e40dce031bf31574976ca05cebc39fd575600b7881064329b2ab3f523ade3cd3",
    ),
];
#[derive(Default)]
struct Args {
    action: String,
    directory: PathBuf,
    archive: Option<PathBuf>,
    version: Option<String>,
    origin: Option<String>,
    port: u16,
    project: String,
    contact: String,
    backup: Option<PathBuf>,
    yes: bool,
}
impl Args {
    fn parse(words: impl Iterator<Item = String>) -> Result<Self> {
        let mut result = Self {
            directory: "/opt/piccove".into(),
            port: 18081,
            project: "piccove-tu".into(),
            ..Self::default()
        };
        let mut words = words.peekable();
        let mut seen = BTreeSet::new();
        while let Some(word) = words.next() {
            ensure!(seen.insert(word.clone()), "重复参数：{word}");
            match word.as_str() {
                "--help" | "-h" => result.action = "help".into(),
                "--non-interactive" | "--yes" => result.yes = true,
                "--directory" => result.directory = words.next().context("缺少安装目录")?.into(),
                "--archive" => {
                    result.archive = Some(words.next().context("缺少发行包路径")?.into())
                }
                "--version" => result.version = Some(words.next().context("缺少版本号")?),
                "--origin" => result.origin = Some(words.next().context("缺少网站 Origin")?),
                "--port" => result.port = words.next().context("缺少端口")?.parse()?,
                "--project" => result.project = words.next().context("缺少项目名")?,
                "--contact" => result.contact = words.next().context("缺少联系地址")?,
                "--backup" => result.backup = Some(words.next().context("缺少备份目录")?.into()),
                _ if !word.starts_with('-') && result.action.is_empty() => result.action = word,
                _ => bail!("不支持的参数：{word}"),
            }
        }
        ensure!(
            [
                "", "help", "menu", "install", "update", "upgrade", "status", "start", "stop",
                "restart", "logs", "health", "backup"
            ]
            .contains(&result.action.as_str()),
            "未知操作"
        );
        ensure!(
            result.directory.is_absolute()
                && !result
                    .directory
                    .components()
                    .any(|c| matches!(c, Component::ParentDir)),
            "安装目录必须为不含 .. 的绝对路径"
        );
        if let Some(v) = &result.version {
            version(v)?;
        }
        ensure!(
            result.archive.is_none() || result.version.is_none(),
            "--archive 与 --version 不能同时使用"
        );
        let upgrade = matches!(result.action.as_str(), "install" | "update" | "upgrade");
        ensure!(
            upgrade || (result.archive.is_none() && result.version.is_none()),
            "--archive／--version 仅用于安装或升级"
        );
        ensure!(
            result.backup.is_none() || result.action == "backup",
            "升级不自动备份；请单独执行 backup"
        );
        ensure!(
            result.action == "install"
                || !["--origin", "--port", "--project", "--contact"]
                    .iter()
                    .any(|flag| seen.contains(*flag)),
            "配置参数仅用于首次安装，升级保留现有 .env"
        );
        Ok(result)
    }
}
#[derive(Serialize, Deserialize)]
struct Manifest {
    version: String,
    target: String,
    commit: String,
    dirty: bool,
    #[serde(default)]
    files: BTreeMap<String, String>,
}
fn version(value: &str) -> Result<(u64, u64, u64)> {
    let words: Vec<_> = value
        .strip_prefix('v')
        .unwrap_or(value)
        .split('.')
        .collect();
    ensure!(
        words.len() == 3
            && words.iter().all(|s| !s.is_empty()
                && s.bytes().all(|b| b.is_ascii_digit())
                && (s.len() == 1 || !s.starts_with('0'))),
        "版本必须为 X.Y.Z"
    );
    Ok((words[0].parse()?, words[1].parse()?, words[2].parse()?))
}
fn digest(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn ordinary(path: &Path) -> Result<()> {
    for p in path.ancestors() {
        match fs::symlink_metadata(p) {
            Ok(m) => ensure!(
                !m.file_type().is_symlink(),
                "拒绝符号链接路径：{}",
                p.display()
            ),
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
fn managed(name: &str) -> bool {
    let path = Path::new(name);
    !name.is_empty()
        && path.components().all(|p| matches!(p, Component::Normal(_)))
        && (matches!(
            name,
            "compose.yml"
                | "release.json"
                | "install.sh"
                | "piccove.sh"
                | "README.md"
                | "bin/piccove-api"
                | "bin/piccovectl"
        ) || name.starts_with("web/")
            || name.starts_with("deploy/")
            || name.starts_with("docs/"))
}
struct Runtime {
    cancelled: Arc<AtomicBool>,
}
impl Runtime {
    fn new() -> Result<Self> {
        let cancelled = Arc::new(AtomicBool::new(false));
        for signal in [signal_hook::consts::SIGINT, signal_hook::consts::SIGTERM] {
            signal_hook::flag::register(signal, cancelled.clone())?;
        }
        Ok(Self { cancelled })
    }
    // External tools run in an owned process group; output stays in a task-owned temporary file.
    fn command(&self, cmd: &mut Command, output: Option<&Path>, timeout: u64) -> Result<String> {
        ensure!(!self.cancelled.load(Ordering::Relaxed), "操作已中断");
        let temporary = tempfile::NamedTempFile::new_in("/var/tmp")?;
        let stdout = match output {
            Some(p) => OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(p)?,
            None => temporary.reopen()?,
        };
        let label = cmd.get_program().to_string_lossy().into_owned();
        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(Stdio::inherit())
            .process_group(0)
            .spawn()?;
        let pid = child.id() as i32;
        let start = Instant::now();
        let result = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Ok(s),
                Err(e) => break Err(e.into()),
                _ => (),
            }
            if self.cancelled.load(Ordering::Relaxed)
                || start.elapsed() > Duration::from_secs(timeout)
            {
                break Err(anyhow::anyhow!("{label} 中断或超时"));
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        unsafe {
            libc::kill(-pid, libc::SIGTERM);
        }
        for _ in 0..20 {
            if child.try_wait()?.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
        let _ = child.wait();
        let status = result?;
        ensure!(
            status.success(),
            "{label} 执行失败（{status}）；请检查上方错误"
        );
        if output.is_some() {
            Ok(String::new())
        } else {
            Ok(fs::read_to_string(temporary.path())?)
        }
    }
    fn docker(&self, args: &[&str]) -> Result<String> {
        self.command(Command::new("docker").args(args), None, 120)
    }
    fn compose(&self, root: &Path, args: &[&str], output: Option<&Path>) -> Result<String> {
        self.command(
            Command::new("docker")
                .arg("compose")
                .arg("--project-directory")
                .arg(root)
                .args(args)
                .current_dir(root),
            output,
            600,
        )
    }
}
fn client() -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(300))
        .user_agent("piccovectl")
        .build()?)
}
fn download(url: &str, path: &Path, limit: u64) -> Result<()> {
    let mut response = client()?
        .get(url)
        .send()?
        .error_for_status()?
        .take(limit + 1);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    ensure!(
        io::copy(&mut response, &mut file)? <= limit,
        "下载文件超出大小限制"
    );
    Ok(())
}
fn fetch(work: &Path, selected: Option<&str>) -> Result<PathBuf> {
    let tag = match selected {
        Some(v) => {
            version(v)?;
            format!("v{}", v.trim_start_matches('v'))
        }
        None => {
            let response = client()?
                .get("https://api.github.com/repos/dovetaill/PicCove/releases/latest")
                .send()?
                .error_for_status()?;
            let mut bytes = Vec::new();
            response.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 1024 * 1024, "Release 元数据过大");
            let data: Value = serde_json::from_slice(&bytes)?;
            ensure!(
                data["draft"] == false && data["prerelease"] == false,
                "不是稳定 Release"
            );
            let tag = data["tag_name"].as_str().context("Release 缺少 tag")?;
            version(tag)?;
            tag.to_string()
        }
    };
    let name = format!("piccove-{tag}-linux-x86_64.tar.gz");
    println!("下载 GitHub Release {tag}…");
    download(
        &format!("{REPO}/releases/download/{tag}/SHA256SUMS"),
        &work.join("SHA256SUMS"),
        65536,
    )?;
    download(
        &format!("{REPO}/releases/download/{tag}/{name}"),
        &work.join(&name),
        512 * 1024 * 1024,
    )?;
    Ok(work.join(name))
}
fn unpack(archive: &Path, destination: &Path) -> Result<(PathBuf, Manifest)> {
    ordinary(archive)?;
    let name = archive
        .file_name()
        .context("发行包名称无效")?
        .to_string_lossy();
    let sums = fs::read_to_string(archive.with_file_name("SHA256SUMS"))?;
    let matches: Vec<_> = sums
        .lines()
        .filter_map(|l| {
            let mut w = l.split_whitespace();
            Some((w.next()?, w.next()?.trim_start_matches('*')))
        })
        .filter(|(_, n)| *n == name)
        .collect();
    ensure!(
        matches.len() == 1 && matches[0].0 == digest(archive)?,
        "发行包 SHA-256 不匹配"
    );
    let root = name.strip_suffix(".tar.gz").context("发行包名称无效")?;
    let v = root
        .strip_prefix("piccove-v")
        .and_then(|s| s.strip_suffix("-linux-x86_64"))
        .context("发行包名称无效")?;
    version(v)?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(File::open(archive)?));
    let mut seen = BTreeSet::new();
    let mut size = 0u64;
    for item in tar.entries()? {
        let mut item = item?;
        let path = item.path()?.into_owned();
        ensure!(
            path.components().all(|c| matches!(c, Component::Normal(_))),
            "发行包含不安全路径"
        );
        let relative = path.strip_prefix(root).context("发行包有多个根目录")?;
        let text = relative.to_str().context("发行包路径不是 UTF-8")?;
        let kind = item.header().entry_type();
        ensure!(kind.is_file() || kind.is_dir(), "发行包含链接或特殊文件");
        ensure!(
            seen.insert(path.clone()) && seen.len() < 100000,
            "发行包路径重复或过多"
        );
        size = size.checked_add(item.size()).context("发行包过大")?;
        ensure!(size < 2 * 1024 * 1024 * 1024, "发行包过大");
        ensure!(item.header().mode()? & 0o7000 == 0, "发行包含特殊权限");
        let dest = destination.join(&path);
        if kind.is_dir() {
            ensure!(
                text.is_empty()
                    || ["bin", "web", "deploy", "docs"]
                        .iter()
                        .any(|prefix| text == *prefix || text.starts_with(&format!("{prefix}/"))),
                "发行包含未授权目录"
            );
            fs::create_dir_all(&dest)?;
            continue;
        }
        ensure!(managed(text), "发行包含未授权路径：{text}");
        fs::create_dir_all(dest.parent().unwrap())?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(if text.starts_with("bin/") {
                0o755
            } else {
                0o644
            })
            .open(dest)?;
        io::copy(&mut item, &mut output)?;
        output.set_permissions(fs::Permissions::from_mode(if text.starts_with("bin/") {
            0o755
        } else {
            0o644
        }))?;
    }
    let bundle = destination.join(root);
    let manifest: Manifest = serde_json::from_slice(&fs::read(bundle.join("release.json"))?)?;
    ensure!(
        manifest.version == v && manifest.target == TARGET && !manifest.dirty,
        "发行元数据无效或是未提交工作区构建"
    );
    ensure!(
        manifest.commit.len() == 40 && manifest.commit.bytes().all(|b| b.is_ascii_hexdigit()),
        "发行提交无效"
    );
    for n in [
        "bin/piccove-api",
        "bin/piccovectl",
        "web/index.html",
        "compose.yml",
        "deploy/nginx.conf",
        "deploy/Dockerfile.api",
        "deploy/Dockerfile.web",
    ] {
        ensure!(manifest.files.contains_key(n), "发行包缺少 {n}");
    }
    for (n, hash) in &manifest.files {
        ensure!(managed(n) && n != "release.json", "文件清单路径不安全");
        ensure!(digest(&bundle.join(n))? == *hash, "文件校验失败：{n}");
    }
    let actual = files(&bundle)?;
    ensure!(
        actual.len() == manifest.files.len() + 1
            && actual
                .keys()
                .all(|n| n == "release.json" || manifest.files.contains_key(n)),
        "发行文件清单不完整"
    );
    Ok((bundle, manifest))
}
fn files(root: &Path) -> Result<BTreeMap<String, String>> {
    fn walk(root: &Path, path: &Path, out: &mut BTreeMap<String, String>) -> Result<()> {
        for entry in fs::read_dir(path)? {
            let p = entry?.path();
            let m = fs::symlink_metadata(&p)?;
            ensure!(
                !m.file_type().is_symlink(),
                "拒绝目录内链接：{}",
                p.display()
            );
            if m.is_dir() {
                walk(root, &p, out)?;
            } else {
                ensure!(m.is_file(), "不是普通文件");
                out.insert(
                    p.strip_prefix(root)?
                        .to_str()
                        .context("非 UTF-8 路径")?
                        .to_string(),
                    digest(&p)?,
                );
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out)?;
    Ok(out)
}
fn config(rt: &Runtime, root: &Path) -> Result<Value> {
    ordinary(root)?;
    for p in ["compose.yml", ".env", "bin/piccove-api", "release.json"] {
        ordinary(&root.join(p))?;
        ensure!(root.join(p).is_file(), "不是完整安装：{p}");
    }
    let c: Value =
        serde_json::from_str(&rt.compose(root, &["config", "--format", "json"], None)?)?;
    let services = c["services"].as_object().context("无服务配置")?;
    ensure!(
        services.len() == 3
            && ["api", "web", "postgres"]
                .iter()
                .all(|s| services.contains_key(*s)),
        "服务配置不属于 PicCove"
    );
    let project = c["name"].as_str().context("缺少 Compose 项目名")?;
    for id in rt
        .docker(&[
            "ps",
            "-aq",
            "--filter",
            &format!("label=com.docker.compose.project={project}"),
        ])?
        .lines()
    {
        let owner = rt.docker(&[
            "inspect",
            "--format",
            "{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}",
            id,
        ])?;
        ensure!(
            Path::new(owner.trim()).canonicalize()? == root.canonicalize()?,
            "同名 Compose 项目属于其他安装目录"
        );
    }
    Ok(c)
}
fn lock(root: &Path) -> Result<File> {
    let path = root.join(".piccove-ops.lock");
    ordinary(&path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    ensure!(file.metadata()?.is_file(), "安装锁不是普通文件");
    fs2::FileExt::try_lock_exclusive(&file).context("已有运维任务正在执行")?;
    Ok(file)
}
fn health(rt: &Runtime, root: &Path) -> Result<()> {
    let c = config(rt, root)?;
    let port = c["services"]["web"]["ports"][0]["published"]
        .as_str()
        .context("缺少本机监听端口")?
        .parse::<u16>()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .no_proxy()
        .build()?;
    let origin = format!("http://127.0.0.1:{port}");
    ensure!(
        client
            .get(format!("{origin}/api/health"))
            .send()?
            .error_for_status()?
            .text()?
            == "ok",
        "API 不健康"
    );
    let html = client
        .get(format!("{origin}/"))
        .send()?
        .error_for_status()?
        .text()?;
    ensure!(html.contains("PicCove"), "网页入口无效");
    let mut count = 0;
    for part in html.split('"') {
        if part.starts_with("/assets/") {
            ensure!(
                Path::new(part.trim_start_matches('/'))
                    .components()
                    .all(|p| matches!(p, Component::Normal(_))),
                "资源路径无效"
            );
            let data = client
                .get(format!("{origin}{part}"))
                .send()?
                .error_for_status()?
                .bytes()?;
            ensure!(
                data.as_ref()
                    == fs::read(root.join("web").join(part.trim_start_matches('/')))?.as_slice(),
                "资源传输不完整：{part}"
            );
            count += 1;
        }
    }
    ensure!(count >= 2, "网页缺少 JS/CSS");
    println!("本机 API、网页及 JS/CSS 完整传输检查通过。");
    Ok(())
}
fn confirm(args: &Args) -> Result<()> {
    if args.yes {
        return Ok(());
    }
    use std::io::IsTerminal;
    ensure!(
        io::stdin().is_terminal(),
        "非交互执行请加 --non-interactive"
    );
    println!("将执行 {}。输入 yes 继续：", args.action);
    if matches!(args.action.as_str(), "update" | "upgrade") {
        println!("升级成功后不保留历史程序版本，也不自动备份；需要备份请先执行 backup。");
    }
    let mut s = String::new();
    io::stdin().read_line(&mut s)?;
    ensure!(s.trim() == "yes", "已取消");
    Ok(())
}
fn environment(args: &Args) -> Result<String> {
    let origin = args
        .origin
        .as_deref()
        .context("首次安装需要 --origin https://你的域名")?;
    let url = reqwest::Url::parse(origin)?;
    ensure!(
        ["https", "http"].contains(&url.scheme())
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && !origin.ends_with('/')
            && url.query().is_none()
            && url.fragment().is_none(),
        "Origin 必须只含协议、主机及可选端口"
    );
    ensure!(
        url.scheme() == "https" || matches!(url.host_str(), Some("127.0.0.1" | "localhost")),
        "公网需要 HTTPS"
    );
    ensure!(
        args.port >= 1024
            && !args.project.is_empty()
            && args.project.len() <= 40
            && args.project.as_bytes()[0].is_ascii_lowercase()
            && args
                .project
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
        "端口或项目名无效"
    );
    for value in [origin, &args.contact] {
        ensure!(
            !value
                .chars()
                .any(|c| matches!(c, '\r' | '\n' | '$' | '\'' | '"')),
            "配置含不安全字符"
        );
    }
    ensure!(
        args.contact.is_empty()
            || args.contact.starts_with("https://")
            || args.contact.starts_with("mailto:"),
        "联系地址无效"
    );
    let random = || {
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    };
    Ok(format!("COMPOSE_PROJECT_NAME={}\nPICCOVE_ORIGIN={origin}\nPICCOVE_PORT={}\nDATABASE_PASSWORD={}\nPICCOVE_ADMIN_PASSWORD={}\nCONTACT_URL={}\n",args.project,args.port,random(),random(),args.contact))
}
fn create_program_dirs(path: &Path) -> Result<()> {
    ordinary(path)?;
    if path.exists() {
        ensure!(path.is_dir(), "目标不是目录");
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        create_program_dirs(parent)?;
    }
    fs::create_dir(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}
fn copy_new(source: &Path, dest: &Path) -> Result<()> {
    ordinary(dest)?;
    create_program_dirs(dest.parent().unwrap())?;
    let mode = fs::metadata(source)?.mode() & 0o777;
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(dest)?;
    io::copy(&mut File::open(source)?, &mut out)?;
    out.set_permissions(fs::Permissions::from_mode(mode))?;
    out.sync_all()?;
    Ok(())
}
fn check_replacement(dest: &Path) -> Result<()> {
    ordinary(dest)?;
    if !dest.exists() {
        return Ok(());
    }
    let m = fs::metadata(dest)?;
    ensure!(
        m.is_file() && m.nlink() == 1 && m.mode() & 0o7000 == 0,
        "目标不是独立普通文件：{}",
        dest.display()
    );
    if dest.file_name().is_some_and(|s| s == "piccovectl") {
        ensure!(
            m.uid() == unsafe { libc::geteuid() } && m.gid() == unsafe { libc::getegid() },
            "运维入口属主不匹配"
        );
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(dest.as_os_str().as_bytes())?;
        let n = unsafe { libc::listxattr(path.as_ptr(), std::ptr::null_mut(), 0) };
        ensure!(
            n == 0,
            "运维入口含扩展属性或无法读取，拒绝丢失 ACL／安全元数据"
        );
    }
    Ok(())
}
fn replace(source: &Path, dest: &Path) -> Result<()> {
    check_replacement(dest)?;
    ordinary(dest)?;
    if !dest.exists() {
        return copy_new(source, dest);
    }
    let m = fs::metadata(dest)?;
    ensure!(m.is_file(), "目标不是普通文件");
    if dest.file_name().is_some_and(|s| s == "piccovectl") {
        ensure!(
            m.uid() == unsafe { libc::geteuid() } && m.gid() == unsafe { libc::getegid() },
            "运维入口属主不匹配"
        );
        let mut temp = tempfile::NamedTempFile::new_in(dest.parent().unwrap())?;
        io::copy(&mut File::open(source)?, &mut temp)?;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(m.mode() & 0o777))?;
        temp.as_file().sync_all()?;
        temp.persist(dest)?;
    } else {
        let mut out = OpenOptions::new()
            .write(true)
            .truncate(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(dest)?;
        io::copy(&mut File::open(source)?, &mut out)?;
        out.sync_all()?;
    }
    Ok(())
}
fn link_command(root: &Path) -> Result<()> {
    if root != Path::new("/opt/piccove") {
        return Ok(());
    }
    let link = Path::new("/usr/local/bin/piccovectl");
    let target = root.join("bin/piccovectl");
    if fs::symlink_metadata(link).is_ok() {
        ensure!(
            link.is_symlink() && fs::read_link(link)? == target,
            "/usr/local/bin/piccovectl 已被其他程序占用"
        );
    } else {
        ordinary(link.parent().unwrap())?;
        symlink(target, link)?;
    }
    Ok(())
}
struct Builder<'a> {
    rt: &'a Runtime,
    name: String,
    work: tempfile::TempDir,
    cleaned: std::cell::Cell<bool>,
}
impl<'a> Builder<'a> {
    fn new(rt: &'a Runtime) -> Result<Self> {
        let name = format!("piccove-build-{}", uuid::Uuid::new_v4().simple());
        let work = tempfile::tempdir_in("/var/tmp")?;
        let builder = Self {
            rt,
            name,
            work,
            cleaned: std::cell::Cell::new(false),
        };
        rt.command(
            Command::new("docker")
                .args([
                    "buildx",
                    "create",
                    "--driver",
                    "docker-container",
                    "--name",
                    &builder.name,
                ])
                .env("DOCKER_CONFIG", builder.work.path()),
            None,
            120,
        )?;
        Ok(builder)
    }
    fn build(&self, root: &Path) -> Result<()> {
        println!("构建运行镜像…");
        self.rt.command(
            Command::new("docker")
                .args(["compose", "--project-directory"])
                .arg(root)
                .args(["build", "api", "web"])
                .current_dir(root)
                .env("BUILDX_BUILDER", &self.name)
                .env("DOCKER_CONFIG", self.work.path()),
            None,
            600,
        )?;
        Ok(())
    }
    fn clean(&self) -> Result<()> {
        if self.cleaned.get() {
            return Ok(());
        }
        // Cleanup must still run after SIGINT/SIGTERM.
        let rt = Runtime {
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        rt.command(
            Command::new("docker")
                .args(["buildx", "rm", "--force", &self.name])
                .env("DOCKER_CONFIG", self.work.path()),
            None,
            120,
        )?;
        self.cleaned.set(true);
        Ok(())
    }
}
impl Drop for Builder<'_> {
    fn drop(&mut self) {
        if let Err(e) = self.clean() {
            eprintln!("构建器 {} 清理失败：{e:#}", self.name);
        }
    }
}
fn old_images(rt: &Runtime, root: &Path) -> Result<BTreeSet<String>> {
    let mut result = BTreeSet::new();
    for service in ["api", "web"] {
        for id in rt.compose(root, &["ps", "-aq", service], None)?.lines() {
            result.insert(
                rt.docker(&["inspect", "--format", "{{.Image}}", id])?
                    .trim()
                    .to_string(),
            );
        }
    }
    Ok(result)
}
fn prune_images(rt: &Runtime, old: &BTreeSet<String>) -> Result<()> {
    for id in old {
        if !rt
            .docker(&["ps", "-aq", "--filter", &format!("ancestor={id}")])?
            .trim()
            .is_empty()
        {
            continue;
        }
        let info: Value = serde_json::from_str(&rt.docker(&["image", "inspect", id])?)?;
        if info[0]["RepoTags"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
        {
            println!("保留仍有标签引用的镜像 {id}");
            continue;
        }
        rt.docker(&["image", "rm", id])?;
    }
    Ok(())
}
fn install(rt: &Runtime, args: &Args, bundle: &Path, manifest: &Manifest) -> Result<()> {
    ordinary(&args.directory)?;
    ensure!(
        !args.directory.exists(),
        "安装目录已存在，请使用 update 或 start"
    );
    let env = environment(args)?;
    confirm(args)?;
    create_program_dirs(args.directory.parent().context("安装目录无父目录")?)?;
    fs::create_dir(&args.directory)?;
    fs::set_permissions(&args.directory, fs::Permissions::from_mode(0o755))?;
    let _lock = lock(&args.directory)?;
    for n in manifest
        .files
        .keys()
        .chain(std::iter::once(&"release.json".to_string()))
    {
        copy_new(&bundle.join(n), &args.directory.join(n))?;
    }
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(args.directory.join(".env"))?;
    f.write_all(env.as_bytes())?;
    f.sync_all()?;
    config(rt, &args.directory)?;
    let builder = Builder::new(rt)?;
    builder.build(&args.directory)?;
    builder.clean()?;
    rt.compose(
        &args.directory,
        &["up", "-d", "--wait", "--wait-timeout", "120"],
        None,
    )?;
    health(rt, &args.directory)?;
    link_command(&args.directory)?;
    println!(
        "安装完成。管理员 admin；初始密码保存在 {}/.env，不在日志打印。",
        args.directory.display()
    );
    Ok(())
}
fn update(rt: &Runtime, args: &Args, bundle: &Path, new: &Manifest) -> Result<()> {
    let root = &args.directory;
    let _lock = lock(root)?;
    config(rt, root)?;
    let pending = root.join(".piccove-update-pending.json");
    ensure!(
        !pending.exists(),
        "上次升级未完成；请核对 .piccove-update-pending.json，未继续覆盖"
    );
    let old: Manifest = serde_json::from_slice(&fs::read(root.join("release.json"))?)?;
    ensure!(
        version(&new.version)? >= version(&old.version)?,
        "拒绝降级，以免旧认证接口绕过二步验证"
    );
    if version(&new.version)? == version(&old.version)? {
        ensure!(new.commit == old.commit, "相同版本提交不一致");
        println!("已是 {}，无需升级。", new.version);
        return Ok(());
    }
    confirm(args)?;
    // Legacy installs have no file manifest: only infer immutable, application-owned web assets.
    let mut old_files = old.files.clone();
    if old_files.is_empty() && root.join("web/assets").is_dir() {
        for (n, h) in files(&root.join("web/assets"))? {
            old_files.insert(format!("web/assets/{n}"), h);
        }
    }
    if old.files.is_empty() {
        for (n, hash) in LEGACY_FILES {
            let p = root.join(n);
            ordinary(&p)?;
            if p.is_file() && digest(&p)? == hash {
                old_files.insert(n.into(), hash.into());
            }
        }
    }
    for n in new
        .files
        .keys()
        .chain(old_files.keys())
        .chain(std::iter::once(&"release.json".into()))
    {
        ensure!(
            managed(n)
                || LEGACY_FILES
                    .iter()
                    .any(|(name, hash)| n == name && old_files.get(n).is_some_and(|h| h == hash)),
            "现有清单含非程序路径"
        );
        check_replacement(&root.join(n))?;
    }
    let mut metadata = BTreeMap::new();
    for n in new
        .files
        .keys()
        .chain(old_files.keys())
        .map(String::as_str)
        .chain([".env", "release.json"])
    {
        let p = root.join(n);
        if p.exists() {
            let m = fs::metadata(&p)?;
            metadata.insert(n.to_string(),json!({"device":m.dev(),"inode":m.ino(),"uid":m.uid(),"gid":m.gid(),"mode":m.mode(),"ctime":m.ctime()}));
        }
    }
    let images = old_images(rt, root)?;
    let mut journal = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&pending)?;
    journal.write_all(serde_json::to_string_pretty(&json!({"from":old.version,"to":new.version,"commit":new.commit,"old_images":images,"old_files":old_files,"metadata_before":metadata}))?.as_bytes())?;
    journal.sync_all()?;
    let outcome = (|| -> Result<()> {
        rt.compose(root, &["stop", "api", "web"], None)?;
        for n in new.files.keys() {
            replace(&bundle.join(n), &root.join(n))?;
        }
        let builder = Builder::new(rt)?;
        builder.build(root)?;
        builder.clean()?;
        rt.compose(root, &["up", "-d", "--wait", "--wait-timeout", "120"], None)?;
        health(rt, root)?;
        replace(&bundle.join("release.json"), &root.join("release.json"))?;
        link_command(root)?;
        for (n, hash) in &old_files {
            if new.files.contains_key(n) {
                continue;
            }
            let path = root.join(n);
            if !path.exists() {
                continue;
            }
            ensure!(digest(&path)? == *hash, "旧程序文件已被修改，保留现场：{n}");
            fs::remove_file(&path)?;
        }
        for (n, before) in &metadata {
            let p = root.join(n);
            if !p.exists() {
                continue;
            }
            let m = fs::metadata(p)?;
            ensure!(
                before["uid"] == m.uid() && before["gid"] == m.gid() && before["mode"] == m.mode(),
                "文件属主或权限变化：{n}"
            );
        }
        prune_images(rt, &images)?;
        fs::remove_file(&pending)?;
        Ok(())
    })();
    if let Err(e) = outcome {
        let cleanup = Runtime {
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        if let Err(stop) = cleanup.compose(root, &["stop", "api", "web"], None) {
            eprintln!("停止失败：{stop:#}");
        }
        bail!(
            "升级未完成：{e:#}。已尝试停止应用并保留 {0}；数据库可能已迁移，不自动回退。",
            pending.display()
        );
    }
    println!(
        "升级到 {} 完成；旧程序文件和无引用旧镜像已清理，未创建自动备份。",
        new.version
    );
    Ok(())
}
fn backup(rt: &Runtime, args: &Args) -> Result<()> {
    let root = &args.directory;
    config(rt, root)?;
    let _lock = lock(root)?;
    let dest = args.backup.clone().unwrap_or_else(|| {
        PathBuf::from(format!(
            "/var/backups/piccove/manual-{}",
            chrono::Utc::now().format("%Y%m%d-%H%M%S")
        ))
    });
    ensure!(
        dest.is_absolute()
            && !dest.components().any(|c| matches!(c, Component::ParentDir))
            && !dest.starts_with(root),
        "备份目录必须是安装目录外的绝对路径"
    );
    ordinary(&dest)?;
    ensure!(!dest.exists(), "备份目录已存在");
    let active = rt.compose(root, &["ps", "--status", "running", "--services"], None)?;
    ensure!(active.lines().any(|s| s == "postgres"), "数据库未运行");
    let running: Vec<_> = ["api", "web"]
        .into_iter()
        .filter(|s| active.lines().any(|v| v == *s))
        .collect();
    fs::create_dir_all(dest.parent().unwrap())?;
    std::os::unix::fs::DirBuilderExt::mode(&mut fs::DirBuilder::new(), 0o700).create(&dest)?;
    let container = format!("piccove-backup-{}", uuid::Uuid::new_v4().simple());
    let result = (|| -> Result<()> {
        if !running.is_empty() {
            let mut stop = vec!["stop"];
            stop.extend(&running);
            rt.compose(root, &stop, None)?;
        }
        rt.compose(
            root,
            &[
                "exec", "-T", "postgres", "pg_dump", "-U", "piccove", "-d", "piccove", "-Fc",
            ],
            Some(&dest.join("database.dump")),
        )?;
        rt.compose(
            root,
            &[
                "run",
                "--name",
                &container,
                "--rm",
                "--no-deps",
                "-T",
                "--entrypoint",
                "tar",
                "api",
                "-czf",
                "-",
                "-C",
                "/data",
                "uploads",
            ],
            Some(&dest.join("images.tar.gz")),
        )?;
        for n in [".env", "release.json", "compose.yml"] {
            let mut out = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(dest.join(n))?;
            io::copy(&mut File::open(root.join(n))?, &mut out)?;
        }
        let mut sums = String::new();
        for entry in fs::read_dir(&dest)? {
            let path = entry?.path();
            ensure!(path.metadata()?.len() > 0, "备份为空");
            sums.push_str(&format!(
                "{}  {}\n",
                digest(&path)?,
                path.file_name().unwrap().to_string_lossy()
            ));
        }
        fs::write(dest.join("SHA256SUMS"), sums)?;
        Ok(())
    })();
    let cleanup = Runtime {
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    if !cleanup
        .docker(&["ps", "-aq", "--filter", &format!("name=^{container}$")])?
        .trim()
        .is_empty()
    {
        cleanup.docker(&["rm", "-f", &container])?;
    }
    if !running.is_empty() {
        let cleanup = Runtime {
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let mut start = vec!["start"];
        start.extend(&running);
        cleanup.compose(root, &start, None)?;
    }
    result.with_context(|| format!("备份未完成，保留现场 {}", dest.display()))?;
    println!("手动备份：{}（含凭据，请妥善保管）", dest.display());
    Ok(())
}
fn dispatch(rt: &Runtime, args: &Args) -> Result<()> {
    if ["help", ""].contains(&args.action.as_str()) {
        println!("piccovectl install --origin https://域名 [--non-interactive]\npiccovectl update [--version X.Y.Z | --archive 包路径] [--non-interactive]\npiccovectl status|start|stop|restart|logs|health\npiccovectl backup [--backup 新目录]\npiccovectl menu\n通用参数：--directory /opt/piccove。仅 Linux x86_64；依赖 Docker Compose。安装／升级不依赖 Python 或 Rust 工具链。升级成功不保留历史程序版本、不自动备份。");
        return Ok(());
    }
    if args.action == "menu" {
        return menu(rt, &args.directory);
    }
    if ["install", "update", "upgrade"].contains(&args.action.as_str()) {
        ensure!(
            std::env::consts::OS == "linux" && std::env::consts::ARCH == "x86_64",
            "仅支持 Linux x86_64"
        );
        if args.action != "install" {
            config(rt, &args.directory)?;
        }
        let work = tempfile::Builder::new()
            .prefix("piccove-download-")
            .tempdir_in("/var/tmp")?;
        let archive = match &args.archive {
            Some(p) => p.canonicalize()?,
            None => fetch(work.path(), args.version.as_deref())?,
        };
        let (bundle, manifest) = unpack(&archive, &work.path().join("stage"))?;
        if args.action == "install" {
            install(rt, args, &bundle, &manifest)
        } else {
            update(rt, args, &bundle, &manifest)
        }
    } else if args.action == "backup" {
        backup(rt, args)
    } else {
        config(rt, &args.directory)?;
        if args.action == "health" {
            return health(rt, &args.directory);
        }
        let _lock = lock(&args.directory)?;
        ensure!(
            !args.directory.join(".piccove-update-pending.json").exists()
                || matches!(args.action.as_str(), "status" | "logs" | "stop"),
            "升级未完成，拒绝启动；请检查升级记录"
        );
        let cmd = match args.action.as_str() {
            "status" => vec!["ps"],
            "logs" => vec!["logs", "--tail=100"],
            "start" => vec!["up", "-d", "--wait", "--wait-timeout", "120"],
            "restart" => vec!["restart", "api", "web"],
            "stop" => {
                confirm(args)?;
                vec!["stop"]
            }
            _ => bail!("未知操作"),
        };
        print!("{}", rt.compose(&args.directory, &cmd, None)?);
        Ok(())
    }
}
fn menu(rt: &Runtime, root: &Path) -> Result<()> {
    use std::io::IsTerminal;
    ensure!(
        io::stdin().is_terminal(),
        "菜单需要交互终端；脚本请指定子命令"
    );
    loop {
        println!("\nPicCove 运维\n1 状态  2 启动  3 停止  4 重启  5 日志  6 健康检查  7 手动备份  8 升级\n0 退出");
        let mut input = String::new();
        ensure!(io::stdin().read_line(&mut input)? > 0, "输入已关闭");
        let action = match input.trim() {
            "0" => return Ok(()),
            "1" => "status",
            "2" => "start",
            "3" => "stop",
            "4" => "restart",
            "5" => "logs",
            "6" => "health",
            "7" => "backup",
            "8" => "update",
            _ => continue,
        };
        let args = Args::parse(
            [
                action.to_string(),
                "--directory".into(),
                root.display().to_string(),
            ]
            .into_iter(),
        )?;
        if let Err(e) = dispatch(rt, &args) {
            eprintln!("操作失败：{e:#}");
        }
    }
}
pub fn run() -> Result<()> {
    let mut args = Args::parse(std::env::args().skip(1))?;
    if args.action.is_empty() {
        args.action = "menu".into();
    }
    dispatch(&Runtime::new()?, &args)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arguments_and_versions() {
        assert!(version("1.2.3").is_ok());
        for v in ["1.2", "01.2.3", "1.2.3/../x", "-1.2.3"] {
            assert!(version(v).is_err());
        }
        assert!(Args::parse(["update", "--unknown"].into_iter().map(str::to_string)).is_err());
        assert!(Args::parse(
            ["update", "--version", "1.2.3", "--archive", "x"]
                .into_iter()
                .map(str::to_string)
        )
        .is_err());
    }
    #[test]
    fn rejects_ignored_options() {
        for words in [
            vec!["update", "--backup", "/some/backup"],
            vec!["update", "--origin", "https://new.example.com"],
            vec!["start", "--version", "1.2.3"],
        ] {
            assert!(Args::parse(words.into_iter().map(str::to_string)).is_err());
        }
    }
    #[test]
    fn paths_and_symlinks() {
        for p in [
            "../.env",
            "/tmp/x",
            ".env",
            "web/../../.env",
            "scripts/other",
        ] {
            assert!(!managed(p));
        }
        assert!(managed("web/assets/app.js"));
        let t = tempfile::tempdir().unwrap();
        symlink("/tmp", t.path().join("link")).unwrap();
        assert!(ordinary(&t.path().join("link/child")).is_err());
    }
    #[test]
    fn configuration_keeps_secrets_out_of_output() {
        let a = Args::parse(
            ["install", "--origin", "https://img.example.com"]
                .into_iter()
                .map(str::to_string),
        )
        .unwrap();
        let env = environment(&a).unwrap();
        assert!(env.contains("PICCOVE_ORIGIN=https://img.example.com"));
        assert_ne!(env, environment(&a).unwrap());
        let a = Args::parse(
            ["install", "--origin", "https://img.example.com/$bad"]
                .into_iter()
                .map(str::to_string),
        )
        .unwrap();
        assert!(environment(&a).is_err());
    }
    #[test]
    fn replacement_preserves_metadata_and_rejects_links() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("new");
        fs::write(&src, b"new binary").unwrap();
        for name in ["piccovectl", "app.js"] {
            let dest = t.path().join(name);
            fs::write(&dest, b"old").unwrap();
            fs::set_permissions(&dest, fs::Permissions::from_mode(0o750)).unwrap();
            let before = fs::metadata(&dest).unwrap();
            replace(&src, &dest).unwrap();
            let after = fs::metadata(&dest).unwrap();
            assert_eq!(
                (before.uid(), before.gid(), before.mode()),
                (after.uid(), after.gid(), after.mode())
            );
            assert_eq!(fs::read(&dest).unwrap(), b"new binary");
        }
        let dest = t.path().join("hardlink");
        fs::hard_link(&src, &dest).unwrap();
        assert!(replace(&src, &dest).is_err());
    }
    #[test]
    fn new_program_directories_are_readable_without_changing_existing_ones() {
        let t = tempfile::tempdir().unwrap();
        let existing = t.path().join("existing");
        fs::create_dir(&existing).unwrap();
        fs::set_permissions(&existing, fs::Permissions::from_mode(0o700)).unwrap();
        let nested = existing.join("web/assets");
        create_program_dirs(&nested).unwrap();
        assert_eq!(fs::metadata(&existing).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(&nested).unwrap().mode() & 0o777, 0o755);
    }
    fn archive_fixture(root: &Path, extra: Option<(&str, bool)>) -> PathBuf {
        let name = "piccove-v1.2.3-linux-x86_64";
        let stage = root.join(name);
        fs::create_dir(&stage).unwrap();
        for n in [
            "bin/piccove-api",
            "bin/piccovectl",
            "web/index.html",
            "compose.yml",
            "deploy/nginx.conf",
            "deploy/Dockerfile.api",
            "deploy/Dockerfile.web",
        ] {
            let p = stage.join(n);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, b"fixture").unwrap();
        }
        let manifest = Manifest {
            version: "1.2.3".into(),
            target: TARGET.into(),
            commit: "a".repeat(40),
            dirty: false,
            files: files(&stage).unwrap(),
        };
        fs::write(
            stage.join("release.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let archive = root.join(format!("{name}.tar.gz"));
        let gzip = flate2::write::GzEncoder::new(
            File::create(&archive).unwrap(),
            flate2::Compression::default(),
        );
        let mut tar = tar::Builder::new(gzip);
        tar.append_dir_all(name, &stage).unwrap();
        if let Some((path, link)) = extra {
            let mut h = tar::Header::new_gnu();
            h.set_size(0);
            h.set_mode(0o644);
            if link {
                h.set_entry_type(tar::EntryType::Symlink);
                h.set_link_name("/tmp").unwrap();
            }
            h.set_cksum();
            tar.append_data(&mut h, path, io::empty()).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
        fs::write(
            root.join("SHA256SUMS"),
            format!(
                "{}  {}\n",
                digest(&archive).unwrap(),
                archive.file_name().unwrap().to_str().unwrap()
            ),
        )
        .unwrap();
        archive
    }
    #[test]
    fn archive_checks_contents_checksum_and_links() {
        let t = tempfile::tempdir().unwrap();
        let a = archive_fixture(t.path(), None);
        let (root, _) = unpack(&a, &t.path().join("out")).unwrap();
        assert!(root.join("bin/piccovectl").is_file());
        assert_eq!(
            fs::metadata(root.join("bin/piccovectl")).unwrap().mode() & 0o777,
            0o755
        );
        fs::write(&a, b"tampered").unwrap();
        assert!(unpack(&a, &t.path().join("bad")).is_err());
        for extra in [
            ("piccove-v1.2.3-linux-x86_64/.env", false),
            ("piccove-v1.2.3-linux-x86_64/web/link", true),
            ("outside/file", false),
        ] {
            let t = tempfile::tempdir().unwrap();
            let a = archive_fixture(t.path(), Some(extra));
            assert!(unpack(&a, &t.path().join("out")).is_err());
        }
    }
}
