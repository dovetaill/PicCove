use super::*;
use storage::Candidate;

#[derive(Clone, sqlx::FromRow)]
struct Job {
    id: Uuid,
    kind: String,
    source_id: Option<Uuid>,
    target_id: Option<Uuid>,
    user_id: Option<Uuid>,
    album_id: Option<Uuid>,
    is_public: bool,
}
#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct Item {
    id: Uuid,
    job_id: Uuid,
    source_key: String,
    image_id: Uuid,
    sha256: Option<String>,
    source_signature: Option<String>,
    status: String,
    error: Option<String>,
}
async fn job(state: &AppState, id: Uuid) -> ApiResult<Job> {
    sqlx::query_as("SELECT * FROM file_jobs WHERE id=$1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .map_err(internal)?
        .ok_or_else(missing)
}
pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<serde_json::Value>>> {
    administrator(&headers, &state).await?;
    let rows = sqlx::query_scalar("SELECT to_jsonb(j) || jsonb_build_object('total',(SELECT count(*) FROM file_job_items WHERE job_id=j.id),'completed',(SELECT count(*) FROM file_job_items WHERE job_id=j.id AND status='completed'),'failed',(SELECT count(*) FROM file_job_items WHERE job_id=j.id AND status='failed')) FROM file_jobs j ORDER BY created_at DESC LIMIT 30").fetch_all(&state.pool).await.map_err(internal)?;
    Ok(Json(rows))
}
pub async fn details(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(page): Query<super::Page>,
) -> ApiResult<Json<Vec<Item>>> {
    administrator(&headers, &state).await?;
    Ok(Json(sqlx::query_as("SELECT * FROM file_job_items WHERE job_id=$1 ORDER BY (status='failed') DESC,source_key LIMIT 48 OFFSET $2").bind(id).bind(offset(page.page)?).fetch_all(&state.pool).await.map_err(internal)?))
}
#[derive(Deserialize)]
pub struct Migration {
    source_id: Uuid,
    target_id: Uuid,
}
pub async fn migrate(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<Migration>,
) -> ApiResult<Json<serde_json::Value>> {
    administrator(&headers, &state).await?;
    if input.source_id == input.target_id {
        return Err(bad("源目录与目标目录不能相同"));
    }
    let _guard = state.uploads.lock().await;
    let source = storage::by_id(&state, input.source_id).await?;
    let target = storage::by_id(&state, input.target_id).await?;
    source.open()?;
    let dir = target.open()?;
    dir.probe().map_err(storage::io_error)?;
    let needed:i64=sqlx::query_scalar("SELECT COALESCE(SUM(size_bytes),0)::bigint FROM images WHERE storage_root=$1 AND deleted_at IS NULL").bind(&source.path).fetch_one(&state.pool).await.map_err(internal)?;
    if dir.available().map_err(storage::io_error)? < DISK_RESERVE.saturating_add(needed as u64) {
        return Err(bad("目标空间不足以完成迁移并保留安全余量"));
    }
    let id = Uuid::new_v4();
    let mut tx = state.pool.begin().await.map_err(internal)?;
    sqlx::query("INSERT INTO file_jobs(id,kind,source_id,target_id) VALUES($1,'migration',$2,$3)")
        .bind(id)
        .bind(source.id)
        .bind(target.id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO file_job_items(id,job_id,source_key,image_id) SELECT gen_random_uuid(),$1,storage_key,id FROM images WHERE storage_root=$2 AND deleted_at IS NULL")
        .bind(id).bind(&source.path).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("UPDATE settings SET upload_dir=$1 WHERE COALESCE(upload_dir,$3)=$2")
        .bind(&target.path)
        .bind(&source.path)
        .bind(state.upload_dir.to_str().unwrap())
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(serde_json::json!({"id":id})))
}
pub async fn retry(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    administrator(&headers, &state).await?;
    let _guard = state.uploads.lock().await;
    let mut tx = state.pool.begin().await.map_err(internal)?;
    let changed =
        sqlx::query("UPDATE file_jobs SET status='queued' WHERE id=$1 AND status='failed'")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    if changed.rows_affected() == 0 {
        return Err(bad("只有失败任务可以重试"));
    }
    sqlx::query(
        "UPDATE file_job_items SET status='queued',error=NULL WHERE job_id=$1 AND status='failed'",
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn cleanup(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(parent): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    administrator(&headers, &state).await?;
    let _guard = state.uploads.lock().await;
    let original = job(&state, parent).await?;
    let done: bool = sqlx::query_scalar(
        "SELECT status='completed' AND kind='migration' FROM file_jobs WHERE id=$1",
    )
    .bind(parent)
    .fetch_one(&state.pool)
    .await
    .map_err(internal)?;
    if !done {
        return Err(bad("仅可清理已完成迁移的旧副本"));
    }
    let id = Uuid::new_v4();
    let mut tx = state.pool.begin().await.map_err(internal)?;
    sqlx::query("INSERT INTO file_jobs(id,kind,source_id,target_id) VALUES($1,'cleanup',$2,$3)")
        .bind(id)
        .bind(original.source_id)
        .bind(original.target_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO file_job_items(id,job_id,source_key,image_id,sha256,source_signature) SELECT gen_random_uuid(),$1,source_key,image_id,sha256,source_signature FROM file_job_items WHERE job_id=$2 AND status='completed' AND sha256 IS NOT NULL").bind(id).bind(parent).execute(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(serde_json::json!({"id":id})))
}
pub async fn candidates(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    administrator(&headers, &state).await?;
    let Some(root) = state.import_dir.clone() else {
        return Ok(Json(serde_json::json!({"enabled":false,"items":[]})));
    };
    let items = tokio::task::spawn_blocking(move || root.open()?.scan().map_err(storage::io_error))
        .await
        .map_err(internal)??;
    Ok(Json(serde_json::json!({"enabled":true,"items":items})))
}
pub async fn albums(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<Album>>> {
    administrator(&headers, &state).await?;
    Ok(Json(
        sqlx::query_as("SELECT id,name,description FROM albums WHERE user_id=$1 ORDER BY name,id")
            .bind(id)
            .fetch_all(&state.pool)
            .await
            .map_err(internal)?,
    ))
}
#[derive(Deserialize)]
pub struct Import {
    user_id: Uuid,
    album_id: Option<Uuid>,
    #[serde(default)]
    is_public: bool,
    files: Vec<Candidate>,
}
pub async fn import(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<Import>,
) -> ApiResult<Json<serde_json::Value>> {
    administrator(&headers, &state).await?;
    let root = state
        .import_dir
        .clone()
        .ok_or_else(|| bad("未配置待导入目录"))?;
    if input.files.is_empty() || input.files.len() > 1000 {
        return Err(bad("每批选择 1–1000 张图片"));
    }
    let candidates =
        tokio::task::spawn_blocking(move || root.open()?.scan().map_err(storage::io_error))
            .await
            .map_err(internal)??;
    let known: std::collections::HashMap<_, _> = candidates
        .into_iter()
        .map(|f| (f.key, f.signature))
        .collect();
    let mut seen = std::collections::HashSet::new();
    for file in &input.files {
        if known.get(&file.key) != Some(&file.signature) || !seen.insert(&file.key) {
            return Err(bad("文件已变化、重复或不在待导入目录，请重新扫描"));
        }
    }
    let id = Uuid::new_v4();
    let _guard = state.uploads.lock().await;
    let mut tx = state.pool.begin().await.map_err(internal)?;
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND NOT disabled) AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM albums WHERE id=$2 AND user_id=$1))").bind(input.user_id).bind(input.album_id).fetch_one(&mut *tx).await.map_err(internal)?;
    if !valid {
        return Err(bad("用户已禁用、不存在或相册归属错误"));
    }
    sqlx::query(
        "INSERT INTO file_jobs(id,kind,user_id,album_id,is_public) VALUES($1,'import',$2,$3,$4)",
    )
    .bind(id)
    .bind(input.user_id)
    .bind(input.album_id)
    .bind(input.is_public)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    for file in input.files {
        sqlx::query("INSERT INTO file_job_items(id,job_id,source_key,image_id,source_signature) VALUES($1,$2,$3,$4,$5)").bind(Uuid::new_v4()).bind(id).bind(file.key).bind(Uuid::new_v4()).bind(file.signature).execute(&mut *tx).await.map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(Json(serde_json::json!({"id":id})))
}
async fn process(state: &AppState, j: &Job, item: &Item) -> ApiResult<()> {
    let current: Option<ImageRow> = sqlx::query_as("SELECT * FROM images WHERE id=$1")
        .bind(item.image_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(internal)?;
    if j.kind == "import" {
        if let Some(row) = current {
            if row.deleted_at.is_none() {
                return Ok(());
            }
            remove_file_record(state, &row).await?;
        }
        let root = state
            .import_dir
            .clone()
            .ok_or_else(|| bad("未配置待导入目录"))?;
        let source_key = item.source_key.clone();
        let (bytes, signature) = tokio::task::spawn_blocking(move || {
            root.open()?.read(&source_key).map_err(storage::io_error)
        })
        .await
        .map_err(internal)??;
        if item.source_signature.as_deref() != Some(&signature) {
            return Err(bad("源文件已变化，请重新扫描后创建导入任务"));
        }
        let user = j.user_id.ok_or_else(|| bad("任务缺少用户"))?;
        let import_key = storage::hash(
            format!(
                "{}\0{}\0{}\0{}",
                state.import_dir.as_ref().unwrap().path,
                item.source_key,
                user,
                storage::hash(&bytes)
            )
            .as_bytes(),
        );
        let existing: Option<ImageRow> = sqlx::query_as("SELECT * FROM images WHERE import_key=$1")
            .bind(&import_key)
            .fetch_optional(&state.pool)
            .await
            .map_err(internal)?;
        let row = if let Some(row) = existing {
            if row.deleted_at.is_some() {
                remove_file_record(state, &row).await?;
                None
            } else {
                Some(row)
            }
        } else {
            None
        };
        let row = match row {
            Some(row) => row,
            None => {
                store_image(
                    state,
                    user,
                    std::path::Path::new(&item.source_key)
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .chars()
                        .take(200)
                        .collect(),
                    Bytes::from(bytes),
                    j.is_public,
                    j.album_id,
                    item.image_id,
                    Some(import_key),
                )
                .await?
            }
        };
        sqlx::query("UPDATE file_job_items SET image_id=$1 WHERE id=$2")
            .bind(row.id)
            .bind(item.id)
            .execute(&state.pool)
            .await
            .map_err(internal)?;
        return Ok(());
    }
    let source = storage::by_id(state, j.source_id.ok_or_else(|| bad("任务缺少源存储"))?).await?;
    let target = storage::by_id(state, j.target_id.ok_or_else(|| bad("任务缺少目标存储"))?).await?;
    let Some(row) = current.filter(|r| r.deleted_at.is_none()) else {
        return Ok(());
    };
    if j.kind == "cleanup" {
        if row.storage_root.as_deref() != Some(&target.path) {
            return Err(bad("图片位置已改变，拒绝清理旧副本"));
        }
        let key = item.source_key.clone();
        let expected = item.sha256.clone().ok_or_else(|| bad("缺少校验值"))?;
        let signature = item.source_signature.clone();
        let thumb = thumbnails::key(row.id);
        return tokio::task::spawn_blocking(move || {
            let src = source.open()?;
            let dst = target.open()?;
            if storage::hash(&dst.read(&key).map_err(storage::io_error)?.0) != expected {
                return Err(bad("目标校验失败，保留旧副本"));
            }
            match src.read(&key) {
                Ok((bytes, sig)) => {
                    if storage::hash(&bytes) != expected || Some(sig) != signature {
                        return Err(bad("旧副本已变化，拒绝清理"));
                    }
                    src.remove(&key).map_err(storage::io_error)?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(storage::io_error(e)),
            }
            src.remove(&thumb).map_err(storage::io_error)
        })
        .await
        .map_err(internal)?;
    }
    if row.storage_root.as_deref() == Some(&target.path) {
        let bytes = storage::read_image(state, &row).await?;
        if item.sha256.as_deref() == Some(&storage::hash(&bytes)) {
            return Ok(());
        }
        return Err(bad("已切换图片的校验值不匹配"));
    }
    if row.storage_root.as_deref() != Some(&source.path) {
        return Err(bad("图片位置已改变，请重新创建迁移任务"));
    }
    let src = source.clone();
    let key = item.source_key.clone();
    let (bytes, signature) =
        tokio::task::spawn_blocking(move || src.open()?.read(&key).map_err(storage::io_error))
            .await
            .map_err(internal)??;
    let hash = storage::hash(&bytes);
    if item.sha256.as_ref().is_some_and(|h| h != &hash) {
        return Err(bad("源图片自上次尝试后发生变化"));
    }
    sqlx::query("UPDATE file_job_items SET sha256=$1,source_signature=$2 WHERE id=$3")
        .bind(&hash)
        .bind(signature)
        .bind(item.id)
        .execute(&state.pool)
        .await
        .map_err(internal)?;
    let dst = target.clone();
    let key = item.source_key.clone();
    let id = item.id;
    tokio::task::spawn_blocking(move || {
        let dir = dst.open()?;
        if dir.available().map_err(storage::io_error)? < DISK_RESERVE + bytes.len() as u64 {
            return Err(bad("目标空间不足"));
        }
        dir.copy_verified(&key, &bytes, id)
            .map_err(storage::io_error)
    })
    .await
    .map_err(internal)??;
    sqlx::query(
        "UPDATE images SET storage_root=$1 WHERE id=$2 AND storage_root=$3 AND deleted_at IS NULL",
    )
    .bind(target.path)
    .bind(row.id)
    .bind(source.path)
    .execute(&state.pool)
    .await
    .map_err(internal)?;
    Ok(())
}
pub async fn worker(
    state: Arc<AppState>,
    mut stop: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    sqlx::query("UPDATE file_job_items SET status='queued' WHERE status='running'")
        .execute(&state.pool)
        .await?;
    sqlx::query("UPDATE file_jobs SET status='queued' WHERE status='running'")
        .execute(&state.pool)
        .await?;
    loop {
        if *stop.borrow() {
            break;
        }
        let result = step(&state).await;
        match result {
            Ok(true) => {
                tokio::task::yield_now().await;
                continue;
            }
            Err(error) => tracing::error!(?error, "file job worker failed"),
            _ => (),
        }
        tokio::select! {_=stop.changed()=>(),_=tokio::time::sleep(std::time::Duration::from_secs(1))=>()}
    }
    Ok(())
}
async fn step(state: &AppState) -> ApiResult<bool> {
    let _guard = state.uploads.lock().await;
    let j:Option<Job>=sqlx::query_as("SELECT * FROM file_jobs WHERE status IN ('queued','running') ORDER BY created_at,id LIMIT 1").fetch_optional(&state.pool).await.map_err(internal)?;
    let Some(j) = j else { return Ok(false) };
    sqlx::query("UPDATE file_jobs SET status='running' WHERE id=$1")
        .bind(j.id)
        .execute(&state.pool)
        .await
        .map_err(internal)?;
    let item:Option<Item>=sqlx::query_as("SELECT * FROM file_job_items WHERE job_id=$1 AND status IN ('queued','running') ORDER BY source_key LIMIT 1").bind(j.id).fetch_optional(&state.pool).await.map_err(internal)?;
    if let Some(item) = item {
        sqlx::query("UPDATE file_job_items SET status='running' WHERE id=$1")
            .bind(item.id)
            .execute(&state.pool)
            .await
            .map_err(internal)?;
        let result = process(state, &j, &item).await;
        let error = result.err().map(|e| e.1);
        sqlx::query("UPDATE file_job_items SET status=$1,error=$2 WHERE id=$3")
            .bind(if error.is_some() {
                "failed"
            } else {
                "completed"
            })
            .bind(error)
            .bind(item.id)
            .execute(&state.pool)
            .await
            .map_err(internal)?;
    } else {
        sqlx::query("UPDATE file_jobs SET status=CASE WHEN EXISTS(SELECT 1 FROM file_job_items WHERE job_id=$1 AND status='failed') THEN 'failed' ELSE 'completed' END WHERE id=$1").bind(j.id).execute(&state.pool).await.map_err(internal)?;
    }
    Ok(true)
}
pub async fn remove_copies(state: &AppState, row: &ImageRow) -> ApiResult<()> {
    let copies:Vec<(String,String,String)>=sqlx::query_as("SELECT DISTINCT l.path,i.source_key,i.sha256 FROM file_job_items i JOIN file_jobs j ON j.id=i.job_id JOIN storage_locations l ON l.id=j.source_id OR l.id=j.target_id WHERE j.kind='migration' AND i.image_id=$1 AND i.sha256 IS NOT NULL").bind(row.id).fetch_all(&state.pool).await.map_err(internal)?;
    for (path, key, hash) in copies {
        if row.storage_root.as_deref() == Some(&path) {
            continue;
        }
        let location = storage::location(state, &path).await?;
        let thumb = thumbnails::key(row.id);
        tokio::task::spawn_blocking(move || {
            let dir = location.open()?;
            match dir.read(&key) {
                Ok((bytes, _)) => {
                    if storage::hash(&bytes) != hash {
                        return Err(bad("迁移副本已变化，删除停止"));
                    }
                    dir.remove(&key).map_err(storage::io_error)?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(storage::io_error(e)),
            }
            dir.remove(&thumb).map_err(storage::io_error)
        })
        .await
        .map_err(internal)??;
    }
    Ok(())
}
