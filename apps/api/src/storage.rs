use super::*;
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    path::{Component, Path as FsPath},
};

#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct Location {
    pub id: Uuid,
    pub path: String,
    pub identity: String,
}

// Keep operations relative to open directory handles: replacing a symlink cannot redirect an in-flight write.
pub struct Directory(File);
fn io_bad(error: std::io::Error) -> ApiError {
    tracing::warn!(?error, "storage operation failed");
    bad("存储不可用、文件已变化或访问被拒绝，请检查挂载及目录权限")
}
fn names(path: &FsPath, absolute: bool) -> std::io::Result<Vec<CString>> {
    if path.is_absolute() != absolute {
        return Err(std::io::Error::other("invalid path"));
    }
    let mut names = Vec::new();
    for part in path.components() {
        match part {
            Component::RootDir if absolute => (),
            Component::Normal(s) => names.push(CString::new(s.as_encoded_bytes())?),
            _ => return Err(std::io::Error::other("invalid component")),
        }
    }
    if names.is_empty() {
        return Err(std::io::Error::other("empty path"));
    }
    Ok(names)
}
fn open_at(parent: &File, name: &CString, flags: i32) -> std::io::Result<File> {
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            0o640,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
impl Directory {
    pub fn open(path: &FsPath) -> std::io::Result<Self> {
        let mut file = File::open("/")?;
        for name in names(path, true)? {
            file = open_at(&file, &name, libc::O_RDONLY | libc::O_DIRECTORY)?;
        }
        Ok(Self(file))
    }
    pub fn identity(&self) -> std::io::Result<String> {
        let m = self.0.metadata()?;
        Ok(format!("{}:{}", m.dev(), m.ino()))
    }
    pub fn available(&self) -> std::io::Result<u64> {
        fs2::available_space(format!("/proc/self/fd/{}", self.0.as_raw_fd()))
    }
    pub fn lock(&self) -> std::io::Result<File> {
        let file = open_at(
            &self.0,
            &CString::new(".piccove.lock")?,
            libc::O_WRONLY | libc::O_CREAT,
        )?;
        if !file.metadata()?.is_file() {
            return Err(std::io::Error::other("invalid storage lock"));
        }
        fs2::FileExt::try_lock_exclusive(&file)?;
        Ok(file)
    }
    fn parent(&self, key: &str, create: bool) -> std::io::Result<(File, CString)> {
        let mut parts = names(FsPath::new(key), false)?;
        let name = parts.pop().unwrap();
        let mut parent = self.0.try_clone()?;
        for part in parts {
            if create && unsafe { libc::mkdirat(parent.as_raw_fd(), part.as_ptr(), 0o750) } < 0 {
                let e = std::io::Error::last_os_error();
                if e.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(e);
                }
            }
            parent = open_at(&parent, &part, libc::O_RDONLY | libc::O_DIRECTORY)?;
            if parent.metadata()?.dev() != self.0.metadata()?.dev() {
                return Err(std::io::Error::other("nested mount rejected"));
            }
        }
        Ok((parent, name))
    }
    pub fn read(&self, key: &str) -> std::io::Result<(Vec<u8>, String)> {
        let (parent, name) = self.parent(key, false)?;
        let mut file = open_at(&parent, &name, libc::O_RDONLY)?;
        let before = file.metadata()?;
        if !before.is_file() || before.len() > MAX_UPLOAD_BYTES as u64 {
            return Err(std::io::Error::other("not a bounded regular image"));
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(MAX_UPLOAD_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        if bytes.len() as u64 != before.len() || signature(&before) != signature(&after) {
            return Err(std::io::Error::other("file changed during read"));
        }
        Ok((bytes, signature(&after)))
    }
    pub fn write_new(&self, key: &str, bytes: &[u8]) -> std::io::Result<()> {
        let (parent, name) = self.parent(key, true)?;
        let mut file = open_at(
            &parent,
            &name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )?;
        file.write_all(bytes)?;
        file.sync_all()?;
        parent.sync_all()
    }
    pub fn remove(&self, key: &str) -> std::io::Result<()> {
        let (parent, name) = match self.parent(key, false) {
            Ok(p) => p,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        match open_at(&parent, &name, libc::O_RDONLY) {
            Ok(file) if !file.metadata()?.is_file() => {
                return Err(std::io::Error::other("not regular"))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
            _ => (),
        }
        if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        parent.sync_all()
    }
    pub fn probe(&self) -> std::io::Result<()> {
        let name = format!(".piccove-probe-{}", Uuid::new_v4());
        let result = self.write_new(&name, b"probe");
        let cleanup = self.remove(&name);
        result.and(cleanup)
    }
    pub fn copy_verified(&self, key: &str, bytes: &[u8], item: Uuid) -> std::io::Result<()> {
        match self.read(key) {
            Ok((existing, _)) if hash(&existing) == hash(bytes) => return Ok(()),
            Ok(_) => return Err(std::io::Error::other("destination conflict")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
        let (parent, final_name) = self.parent(key, true)?;
        let temporary = CString::new(format!(".piccove-{item}.part"))?;
        // A fixed task-owned temporary name makes an interrupted copy restartable without overwriting the final image.
        if unsafe { libc::unlinkat(parent.as_raw_fd(), temporary.as_ptr(), 0) } < 0
            && std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound
        {
            return Err(std::io::Error::last_os_error());
        }
        let mut file = open_at(
            &parent,
            &temporary,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
        )?;
        let result = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            use std::io::{Seek, SeekFrom};
            file.seek(SeekFrom::Start(0))?;
            let mut check = Vec::new();
            file.read_to_end(&mut check)?;
            if hash(&check) != hash(bytes) {
                return Err(std::io::Error::other("copy checksum mismatch"));
            }
            if unsafe {
                // The bundled musl may lack the libc wrapper; keep Linux's atomic no-replace syscall.
                libc::syscall(
                    libc::SYS_renameat2,
                    parent.as_raw_fd(),
                    temporary.as_ptr(),
                    parent.as_raw_fd(),
                    final_name.as_ptr(),
                    libc::RENAME_NOREPLACE,
                )
            } < 0
            {
                return Err(std::io::Error::last_os_error());
            }
            parent.sync_all()
        })();
        if result.is_err() {
            unsafe {
                libc::unlinkat(parent.as_raw_fd(), temporary.as_ptr(), 0);
            }
        }
        result
    }
    pub fn scan(&self) -> std::io::Result<Vec<Candidate>> {
        fn walk(
            dir: &Directory,
            prefix: &str,
            files: &mut Vec<Candidate>,
            visited: &mut usize,
        ) -> std::io::Result<()> {
            for entry in std::fs::read_dir(format!("/proc/self/fd/{}", dir.0.as_raw_fd()))? {
                *visited += 1;
                if *visited > 5000 || files.len() >= 1000 {
                    return Err(std::io::Error::other(
                        "split import into batches of at most 1000 files / 5000 entries",
                    ));
                }
                let entry = entry?;
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if name.starts_with('.') {
                    continue;
                }
                let key = format!("{prefix}{name}");
                let typ = entry.file_type()?;
                if typ.is_symlink() {
                    continue;
                }
                if typ.is_dir() {
                    if prefix.bytes().filter(|b| *b == b'/').count() >= 32 {
                        return Err(std::io::Error::other(
                            "import directory nesting exceeds 32 levels",
                        ));
                    }
                    let child = open_at(
                        &dir.0,
                        &CString::new(name)?,
                        libc::O_RDONLY | libc::O_DIRECTORY,
                    )?;
                    if child.metadata()?.dev() != dir.0.metadata()?.dev() {
                        continue;
                    }
                    walk(&Directory(child), &format!("{key}/"), files, visited)?;
                } else if typ.is_file() && candidate_name(&name) {
                    let file = open_at(&dir.0, &CString::new(name)?, libc::O_RDONLY)?;
                    let meta = file.metadata()?;
                    if meta.is_file() && meta.len() <= MAX_UPLOAD_BYTES as u64 {
                        files.push(Candidate {
                            key,
                            size: meta.len(),
                            signature: signature(&meta),
                        });
                    }
                }
            }
            Ok(())
        }
        let mut files = Vec::new();
        walk(self, "", &mut files, &mut 0)?;
        files.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(files)
    }
}
fn candidate_name(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, e)| {
        ["jpg", "jpeg", "png", "webp", "gif"].contains(&e.to_ascii_lowercase().as_str())
    })
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn signature(m: &std::fs::Metadata) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec()
    )
}
#[derive(Serialize, Deserialize)]
pub struct Candidate {
    pub key: String,
    pub size: u64,
    pub signature: String,
}

impl Location {
    pub fn open(&self) -> ApiResult<Directory> {
        let dir = Directory::open(FsPath::new(&self.path)).map_err(io_bad)?;
        if dir.identity().map_err(io_bad)? != self.identity {
            return Err(bad("存储目录身份变化，已停止访问；请确认原磁盘已挂载"));
        }
        Ok(dir)
    }
}
pub async fn location(state: &AppState, path: &str) -> ApiResult<Location> {
    sqlx::query_as("SELECT * FROM storage_locations WHERE path=$1")
        .bind(path)
        .fetch_optional(&state.pool)
        .await
        .map_err(internal)?
        .ok_or_else(|| bad("存储未登记"))
}
pub async fn by_id(state: &AppState, id: Uuid) -> ApiResult<Location> {
    sqlx::query_as("SELECT * FROM storage_locations WHERE id=$1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .map_err(internal)?
        .ok_or_else(missing)
}
pub async fn image_location(state: &AppState, image: &ImageRow) -> ApiResult<Location> {
    location(
        state,
        image
            .storage_root
            .as_deref()
            .unwrap_or(state.upload_dir.to_str().expect("UTF-8 upload path")),
    )
    .await
}
pub async fn current(state: &AppState) -> ApiResult<Location> {
    let path: Option<String> = sqlx::query_scalar("SELECT upload_dir FROM settings")
        .fetch_one(&state.pool)
        .await
        .map_err(internal)?;
    location(
        state,
        path.as_deref()
            .unwrap_or(state.upload_dir.to_str().unwrap()),
    )
    .await
}
pub async fn initialize(state: &AppState) -> anyhow::Result<()> {
    sqlx::query("UPDATE images SET storage_root=$1 WHERE storage_root IS NULL")
        .bind(state.upload_dir.to_str().unwrap())
        .execute(&state.pool)
        .await?;
    let paths: Vec<String> = sqlx::query_scalar("SELECT DISTINCT storage_root FROM images UNION SELECT upload_dir FROM settings WHERE upload_dir IS NOT NULL UNION SELECT $1::text")
        .bind(state.upload_dir.to_str().unwrap()).fetch_all(&state.pool).await?;
    for path in paths {
        if state.import_dir.as_ref().is_some_and(|r| {
            FsPath::new(&path).starts_with(&r.path) || FsPath::new(&r.path).starts_with(&path)
        }) {
            bail!("import directory overlaps storage: {path}");
        }
        let registered: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM storage_locations WHERE path=$1)")
                .bind(&path)
                .fetch_one(&state.pool)
                .await?;
        if registered {
            continue;
        }
        let identity = Directory::open(FsPath::new(&path))
            .and_then(|d| d.identity())
            .with_context(|| format!("mount existing storage before registration: {path}"))?;
        sqlx::query("INSERT INTO storage_locations(id,path,identity) VALUES($1,$2,$3) ON CONFLICT(path) DO NOTHING").bind(Uuid::new_v4()).bind(path).bind(identity).execute(&state.pool).await?;
    }
    Ok(())
}
pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    administrator(&headers, &state).await?;
    let current = current(&state).await?;
    let rows: Vec<Location> =
        sqlx::query_as("SELECT * FROM storage_locations ORDER BY created_at,id")
            .fetch_all(&state.pool)
            .await
            .map_err(internal)?;
    let mut result = Vec::new();
    for row in rows {
        let (count, used): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*),COALESCE(SUM(size_bytes),0)::bigint FROM images WHERE storage_root=$1",
        )
        .bind(&row.path)
        .fetch_one(&state.pool)
        .await
        .map_err(internal)?;
        let (available, error) = match row.open().and_then(|d| d.available().map_err(io_bad)) {
            Ok(n) => (Some(n), None),
            Err(e) => (None, Some(e.1)),
        };
        result.push(serde_json::json!({"id":row.id,"path":row.path,"default":row.id==current.id,"count":count,"used_bytes":used,"available_bytes":available,"error":error}));
    }
    Ok(Json(
        serde_json::json!({"items":result,"allowed_roots":state.storage_roots}),
    ))
}
#[derive(Deserialize)]
pub struct Add {
    path: String,
}
pub async fn add(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<Add>,
) -> ApiResult<StatusCode> {
    administrator(&headers, &state).await?;
    let path = PathBuf::from(input.path.trim());
    if !state.storage_roots.iter().any(|r| path.starts_with(r)) {
        return Err(bad("目录不在允许的存储根目录内"));
    }
    let dir = Directory::open(&path).map_err(io_bad)?;
    dir.probe().map_err(io_bad)?;
    let identity = dir.identity().map_err(io_bad)?;
    let _guard = state.uploads.lock().await;
    // Overlapping roots make migration and cleanup ambiguous.
    let roots: Vec<String> = sqlx::query_scalar("SELECT path FROM storage_locations")
        .fetch_all(&state.pool)
        .await
        .map_err(internal)?;
    if roots
        .iter()
        .any(|r| path.starts_with(r) || FsPath::new(r).starts_with(&path))
    {
        return Err(bad("目录已登记或与现有存储目录重叠"));
    }
    if state
        .import_dir
        .as_ref()
        .is_some_and(|r| path.starts_with(&r.path) || FsPath::new(&r.path).starts_with(&path))
    {
        return Err(bad("存储目录不能与待导入目录重叠"));
    }
    sqlx::query("INSERT INTO storage_locations(id,path,identity) VALUES($1,$2,$3)")
        .bind(Uuid::new_v4())
        .bind(path.to_str().ok_or_else(|| bad("路径必须为 UTF-8"))?)
        .bind(identity)
        .execute(&state.pool)
        .await
        .map_err(internal)?;
    Ok(StatusCode::CREATED)
}
pub async fn select(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    administrator(&headers, &state).await?;
    let _guard = state.uploads.lock().await;
    let row = by_id(&state, id).await?;
    row.open()?.probe().map_err(io_bad)?;
    sqlx::query("UPDATE settings SET upload_dir=$1")
        .bind(row.path)
        .execute(&state.pool)
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn read_image(state: &AppState, row: &ImageRow) -> ApiResult<Vec<u8>> {
    let location = image_location(state, row).await?;
    let key = row.storage_key.clone();
    tokio::task::spawn_blocking(move || location.open()?.read(&key).map(|v| v.0).map_err(io_bad))
        .await
        .map_err(internal)?
}
pub fn io_error(error: std::io::Error) -> ApiError {
    io_bad(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_symlinks_copy_and_identity() {
        let temp = tempfile::tempdir().unwrap();
        let dir = Directory::open(temp.path()).unwrap();
        let id = Uuid::new_v4();
        let lock = dir.lock().unwrap();
        assert!(dir.lock().is_err());
        drop(lock);
        std::fs::remove_file(temp.path().join(".piccove.lock")).unwrap();
        std::os::unix::fs::symlink(temp.path().join("other"), temp.path().join(".piccove.lock"))
            .unwrap();
        assert!(dir.lock().is_err());
        assert!(!temp.path().join("other").exists());
        assert!(dir.write_new("../escape", b"x").is_err());
        std::os::unix::fs::symlink("/tmp", temp.path().join("link")).unwrap();
        assert!(dir.write_new("link/escape", b"x").is_err());
        dir.copy_verified("2026/10/a.png", b"original", id).unwrap();
        dir.copy_verified("2026/10/a.png", b"original", id).unwrap();
        assert!(dir
            .copy_verified("2026/10/a.png", b"different", id)
            .is_err());
        assert_eq!(dir.read("2026/10/a.png").unwrap().0, b"original");
        dir.write_new("unfinished.part", b"x").unwrap();
        assert_eq!(dir.scan().unwrap().len(), 1);
        let location = Location {
            id,
            path: temp.path().to_str().unwrap().into(),
            identity: "wrong".into(),
        };
        assert!(location.open().is_err());
        dir.remove("2026/10/a.png").unwrap();
        dir.remove("2026/10/a.png").unwrap();
    }
}
