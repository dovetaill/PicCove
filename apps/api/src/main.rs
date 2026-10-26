mod file_jobs;
mod management;
mod security;
mod storage;
mod thumbnails;

use anyhow::{bail, Context};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, SaltString},
    Argon2, PasswordHasher, PasswordVerifier,
};
use axum::{
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use image::{ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{env, io::Cursor, net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::sync::{Mutex, Semaphore};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use uuid::Uuid;

const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
const DISK_RESERVE: u64 = 1024 * 1024 * 1024;
type ApiResult<T> = Result<T, ApiError>;

struct AppState {
    pool: PgPool,
    upload_dir: PathBuf,
    storage_roots: Vec<PathBuf>,
    import_dir: Option<storage::Location>,
    thumbnails: Arc<Semaphore>,
    public_base_url: String,
    origin: String,
    contact_url: Option<String>,
    uploads: Mutex<()>,
    passwords: Arc<Semaphore>,
    security: security::Security,
}
#[derive(Debug)]
struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({"error":self.1}))).into_response()
    }
}
fn bad(message: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}
fn unauthorized() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "请重新登录".into())
}
fn forbidden() -> ApiError {
    ApiError(StatusCode::FORBIDDEN, "没有操作权限".into())
}
fn missing() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "记录不存在".into())
}
fn internal(error: impl std::fmt::Debug) -> ApiError {
    tracing::error!(?error, "request failed");
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "操作失败，请稍后重试".into(),
    )
}
fn db_error(error: sqlx::Error) -> ApiError {
    if error
        .as_database_error()
        .is_some_and(|e| e.is_unique_violation())
    {
        return bad("用户名已存在");
    }
    internal(error)
}
#[derive(Clone, Serialize, sqlx::FromRow)]
struct User {
    id: Uuid,
    username: String,
    is_admin: bool,
    disabled: bool,
    quota_bytes: i64,
    #[serde(skip_serializing)]
    password_hash: String,
    created_at: DateTime<Utc>,
    #[serde(skip_serializing)]
    security_version: i64,
}
#[derive(Serialize, sqlx::FromRow)]
struct ImageRow {
    id: Uuid,
    user_id: Uuid,
    album_id: Option<Uuid>,
    original_name: String,
    #[serde(skip_serializing)]
    storage_key: String,
    #[serde(skip_serializing)]
    storage_root: Option<String>,
    content_type: String,
    size_bytes: i64,
    width: i32,
    height: i32,
    created_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
    is_public: bool,
}
fn image_dto(row: ImageRow, state: &AppState) -> serde_json::Value {
    let url = format!(
        "{}/i/{}",
        state.public_base_url.trim_end_matches('/'),
        if row.storage_key.contains('/') {
            row.storage_key.clone()
        } else {
            row.id.to_string()
        }
    );
    let mut result = serde_json::to_value(row).expect("serializable image");
    result["thumbnail_url"] = format!(
        "{}/api/v1/images/{}/thumbnail",
        state.public_base_url.trim_end_matches('/'),
        result["id"].as_str().unwrap()
    )
    .into();
    result["url"] = url.into();
    result
}
fn session_token(headers: &HeaderMap) -> ApiResult<String> {
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|cookies| {
            cookies
                .split(';')
                .find_map(|part| part.trim().strip_prefix("piccove_session="))
        })
        .filter(|token| token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_owned)
        .ok_or_else(unauthorized)
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
async fn authenticate(headers: &HeaderMap, state: &AppState) -> ApiResult<User> {
    sqlx::query_as::<_, User>("SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND NOT u.disabled")
        .bind(digest(&session_token(headers)?)).fetch_optional(&state.pool).await.map_err(internal)?.ok_or_else(unauthorized)
}
async fn administrator(headers: &HeaderMap, state: &AppState) -> ApiResult<User> {
    let user = authenticate(headers, state).await?;
    if !user.is_admin {
        return Err(forbidden());
    }
    Ok(user)
}
async fn protect_origin(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    if !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) && request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        != Some(state.origin.as_str())
    {
        return forbidden().into_response();
    }
    next.run(request).await
}
// shortcut: reverse-proxy clients share peer-IP limits; add trusted-proxy handling before scaling public registration.
async fn rate(state: &AppState, key: String, limit: i32, seconds: i32) -> ApiResult<()> {
    sqlx::query("DELETE FROM rate_limits WHERE expires_at < NOW()")
        .execute(&state.pool)
        .await
        .map_err(internal)?;
    let hits: i32 = sqlx::query_scalar("INSERT INTO rate_limits(key,hits,expires_at) VALUES($1,1,NOW()+make_interval(secs=>$2)) ON CONFLICT(key) DO UPDATE SET hits=rate_limits.hits+1 RETURNING hits")
        .bind(key).bind(seconds as f64).fetch_one(&state.pool).await.map_err(internal)?;
    if hits > limit {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "操作过于频繁，请稍后再试".into(),
        ));
    }
    Ok(())
}
fn validate_credentials(username: &str, password: &str) -> ApiResult<()> {
    if !(3..=32).contains(&username.len())
        || !username
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(bad("用户名须为 3–32 位字母、数字、下划线或连字符"));
    }
    validate_password(password)
}
fn validate_password(password: &str) -> ApiResult<()> {
    if !(12..=128).contains(&password.len()) {
        return Err(bad("密码须为 12–128 字节"));
    }
    Ok(())
}
async fn hash_password(password: String, state: &AppState) -> ApiResult<String> {
    validate_password(&password)?;
    let permit = state
        .passwords
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::TOO_MANY_REQUESTS, "请稍后重试".into()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|h| h.to_string())
            .map_err(internal)
    })
    .await
    .map_err(internal)?
}
async fn verify_password(password: String, hash: String, state: &AppState) -> ApiResult<()> {
    validate_password(&password)?;
    let permit = state
        .passwords
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::TOO_MANY_REQUESTS, "请稍后重试".into()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let hash = PasswordHash::new(&hash).map_err(internal)?;
        Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .map_err(|_| unauthorized())
    })
    .await
    .map_err(internal)?
}
#[derive(Deserialize)]
struct Credentials {
    username: String,
    password: String,
    #[serde(default)]
    code: String,
}
fn cookie(token: &str, state: &AppState, max_age: u32) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "piccove_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}{}",
        if state.origin.starts_with("https://") {
            "; Secure"
        } else {
            ""
        }
    ))
    .expect("safe cookie")
}
async fn login(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(input): Json<Credentials>,
) -> ApiResult<Response> {
    rate(&state, format!("login:{}", peer.ip()), 20, 60).await?;
    rate(&state, "login:global".into(), 120, 60).await?;
    validate_credentials(&input.username, &input.password)?;
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE username=$1 AND NOT disabled")
        .bind(&input.username)
        .fetch_optional(&state.pool)
        .await
        .map_err(internal)?
        .ok_or_else(unauthorized)?;
    verify_password(input.password, user.password_hash.clone(), &state).await?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut tx = state.pool.begin().await.map_err(internal)?;
    let current: User = sqlx::query_as("SELECT * FROM users WHERE id=$1 FOR UPDATE")
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    if current.disabled
        || current.password_hash != user.password_hash
        || current.security_version != user.security_version
    {
        return Err(unauthorized());
    }
    security::verify_totp(&mut tx, user.id, &input.code).await?;
    sqlx::query("DELETE FROM sessions WHERE expires_at<NOW()")
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+interval '7 days')",
    )
    .bind(digest(&token))
    .bind(user.id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok((
        [(header::SET_COOKIE, cookie(&token, &state, 604800))],
        Json(user),
    )
        .into_response())
}
async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult<Response> {
    if let Ok(token) = session_token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
            .bind(digest(&token))
            .execute(&state.pool)
            .await
            .map_err(internal)?;
    }
    Ok((
        [(header::SET_COOKIE, cookie("", &state, 0))],
        StatusCode::NO_CONTENT,
    )
        .into_response())
}
async fn register(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(input): Json<Credentials>,
) -> ApiResult<StatusCode> {
    rate(&state, format!("register:{}", peer.ip()), 5, 3600).await?;
    rate(&state, "register:global".into(), 20, 3600).await?;
    validate_credentials(&input.username, &input.password)?;
    let open: bool = sqlx::query_scalar("SELECT registration_open FROM settings")
        .fetch_one(&state.pool)
        .await
        .map_err(internal)?;
    if !open {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "注册暂未开放，请联系管理员".into(),
        ));
    }
    let hash = hash_password(input.password, &state).await?;
    let mut tx = state.pool.begin().await.map_err(internal)?;
    let open: bool = sqlx::query_scalar("SELECT registration_open FROM settings FOR SHARE")
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    if !open {
        return Err(forbidden());
    }
    sqlx::query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)")
        .bind(Uuid::new_v4())
        .bind(input.username)
        .bind(hash)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::CREATED)
}
async fn settings(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    let open: bool = sqlx::query_scalar("SELECT registration_open FROM settings")
        .fetch_one(&state.pool)
        .await
        .map_err(internal)?;
    Ok(Json(
        serde_json::json!({"registration_open":open,"contact_url":state.contact_url,"private_images":true}),
    ))
}
#[derive(Deserialize)]
struct SettingsInput {
    registration_open: bool,
}
async fn update_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<SettingsInput>,
) -> ApiResult<StatusCode> {
    administrator(&headers, &state).await?;
    sqlx::query("UPDATE settings SET registration_open=$1")
        .bind(input.registration_open)
        .execute(&state.pool)
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn me(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    let user = authenticate(&headers, &state).await?;
    let used: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(size_bytes),0)::bigint FROM images WHERE user_id=$1",
    )
    .bind(user.id)
    .fetch_one(&state.pool)
    .await
    .map_err(internal)?;
    Ok(Json(serde_json::json!({"user":user,"used_bytes":used})))
}
#[derive(Deserialize)]
struct PasswordInput {
    current_password: String,
    password: String,
    #[serde(default)]
    code: String,
}
async fn change_password(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<PasswordInput>,
) -> ApiResult<StatusCode> {
    let user = authenticate(&headers, &state).await?;
    rate(&state, format!("password:{}", user.id), 5, 60).await?;
    verify_password(input.current_password, user.password_hash.clone(), &state).await?;
    let hash = hash_password(input.password, &state).await?;
    let mut tx = state.pool.begin().await.map_err(internal)?;
    security::lock_current(&mut tx, &user, &headers).await?;
    security::verify_totp(&mut tx, user.id, &input.code).await?;
    let result = sqlx::query(
        "UPDATE users SET password_hash=$1,security_version=security_version+1 WHERE id=$2 AND password_hash=$3 AND NOT disabled",
    )
    .bind(hash)
    .bind(user.id)
    .bind(user.password_hash)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    if result.rows_affected() == 0 {
        return Err(unauthorized());
    }
    sqlx::query("DELETE FROM sessions WHERE user_id=$1")
        .bind(user.id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
struct Page {
    page: Option<i64>,
    album_id: Option<Uuid>,
    all: Option<bool>,
}
fn offset(page: Option<i64>) -> ApiResult<i64> {
    let page = page.unwrap_or(1);
    if !(1..=1_000_000).contains(&page) {
        return Err(bad("页码无效"));
    }
    Ok((page - 1) * 48)
}
async fn list_images(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<Page>,
) -> ApiResult<Json<serde_json::Value>> {
    let user = authenticate(&headers, &state).await?;
    let all = query.all.unwrap_or(false);
    if all && !user.is_admin {
        return Err(forbidden());
    }
    let rows: Vec<ImageRow> = sqlx::query_as("SELECT * FROM images WHERE ($1 OR user_id=$2) AND ($3::uuid IS NULL OR album_id=$3) ORDER BY created_at DESC,id DESC LIMIT 49 OFFSET $4")
        .bind(all).bind(user.id).bind(query.album_id).bind(offset(query.page)?).fetch_all(&state.pool).await.map_err(internal)?;
    let has_more = rows.len() > 48;
    Ok(Json(
        serde_json::json!({"items": rows.into_iter().take(48).map(|r| image_dto(r,&state)).collect::<Vec<_>>(),"has_more":has_more}),
    ))
}
fn validate_image(bytes: &[u8]) -> ApiResult<(&'static str, &'static str, u32, u32)> {
    if bytes.is_empty() || bytes.len() > MAX_UPLOAD_BYTES {
        return Err(bad("图片大小须为 1 字节至 10 MiB"));
    }
    let format = image::guess_format(bytes).map_err(|_| bad("无效图片"))?;
    let (extension, mime) = match format {
        ImageFormat::Jpeg => ("jpg", "image/jpeg"),
        ImageFormat::Png => ("png", "image/png"),
        ImageFormat::WebP => ("webp", "image/webp"),
        ImageFormat::Gif => ("gif", "image/gif"),
        _ => return Err(bad("仅支持 JPEG、PNG、WebP、GIF")),
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16000);
    limits.max_image_height = Some(16000);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| bad("图片损坏或解码内存超出限制"))?;
    Ok((extension, mime, image.width(), image.height()))
}
#[derive(Deserialize)]
struct UploadOptions {
    private: Option<bool>,
    album_id: Option<Uuid>,
}
async fn upload_image(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(options): Query<UploadOptions>,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<serde_json::Value>)> {
    let user = authenticate(&headers, &state).await?;
    rate(&state, format!("upload:{}", user.id), 60, 60).await?;
    let _guard = state.uploads.lock().await;
    let mut upload: Option<(String, Bytes)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| bad("上传内容无效或过大"))?
    {
        if field.name() != Some("file") {
            continue;
        }
        if upload.is_some() {
            return Err(bad("每次请求只接受一张图片"));
        }
        let name = field
            .file_name()
            .unwrap_or("image")
            .chars()
            .take(200)
            .collect();
        let bytes = field.bytes().await.map_err(|_| bad("上传内容无效或过大"))?;
        upload = Some((name, bytes));
    }
    let (original_name, bytes) = upload.ok_or_else(|| bad("缺少图片"))?;
    let digest = storage::hash(&bytes);
    // Older images acquire their digest lazily; duplicate uploads retain the original visibility and album.
    let candidates: Vec<ImageRow> = sqlx::query_as(
        "SELECT * FROM images WHERE user_id=$1 AND size_bytes=$2 AND deleted_at IS NULL AND (content_hash=$3 OR content_hash IS NULL) ORDER BY created_at,id",
    )
    .bind(user.id)
    .bind(bytes.len() as i64)
    .bind(&digest)
    .fetch_all(&state.pool)
    .await
    .map_err(internal)?;
    for existing in candidates {
        let location = storage::image_location(&state, &existing).await?;
        let key = existing.storage_key.clone();
        let existing_hash = tokio::task::spawn_blocking(move || {
            let dir = location.open()?;
            match dir.read(&key) {
                Ok((data, _)) => Ok(Some(storage::hash(&data))),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(storage::io_error(error)),
            }
        })
        .await
        .map_err(internal)??;
        if let Some(existing_hash) = existing_hash {
            sqlx::query("UPDATE images SET content_hash=$1 WHERE id=$2")
                .bind(&existing_hash)
                .bind(existing.id)
                .execute(&state.pool)
                .await
                .map_err(internal)?;
            if existing_hash == digest {
                let mut result = image_dto(existing, &state);
                result["duplicate"] = serde_json::json!(true);
                return Ok((StatusCode::OK, Json(result)));
            }
        }
    }
    let row = store_image(
        &state,
        user.id,
        original_name,
        bytes,
        !options.private.unwrap_or(false),
        options.album_id,
        Uuid::new_v4(),
        None,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(image_dto(row, &state))))
}
// Callers hold uploads so imports, migration, quota accounting and deletion cannot race.
async fn store_image(
    state: &AppState,
    user_id: Uuid,
    original_name: String,
    bytes: Bytes,
    is_public: bool,
    album_id: Option<Uuid>,
    id: Uuid,
    import_key: Option<String>,
) -> ApiResult<ImageRow> {
    let check_bytes = bytes.clone();
    let (extension, mime, width, height) =
        tokio::task::spawn_blocking(move || validate_image(&check_bytes))
            .await
            .map_err(internal)??;
    let location = storage::current(state).await?;
    let dir = location.open()?;
    if dir.available().map_err(storage::io_error)? < DISK_RESERVE + bytes.len() as u64 {
        return Err(bad("存储空间不足，已暂停上传"));
    }
    let mut tx = state.pool.begin().await.map_err(internal)?;
    let current: User = sqlx::query_as("SELECT * FROM users WHERE id=$1 FOR UPDATE")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    if current.disabled {
        return Err(unauthorized());
    }
    let used: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(size_bytes),0)::bigint FROM images WHERE user_id=$1",
    )
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    if bytes.len() as i64 > current.quota_bytes.saturating_sub(used) {
        return Err(bad("存储配额不足，请联系管理员"));
    }
    let storage_key = format!("{}/{id}.{extension}", Utc::now().format("%Y/%m/%d"));
    if let Some(album_id) = album_id {
        let valid: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM albums WHERE id=$1 AND user_id=$2)")
                .bind(album_id)
                .bind(user_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(internal)?;
        if !valid {
            return Err(bad("相册不属于所选用户"));
        }
    }
    // Keep a pending row until the file is durable; interrupted uploads remain identifiable for cleanup.
    let row: ImageRow=sqlx::query_as("INSERT INTO images(id,user_id,original_name,storage_key,content_type,size_bytes,width,height,deleted_at,is_public,storage_root,album_id,import_key,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10,$11,$12,$13) RETURNING *")
        .bind(id).bind(user_id).bind(original_name).bind(storage_key).bind(mime).bind(bytes.len() as i64).bind(width as i32).bind(height as i32).bind(is_public).bind(&location.path).bind(album_id).bind(import_key).bind(storage::hash(&bytes)).fetch_one(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    let key = row.storage_key.clone();
    tokio::task::spawn_blocking(move || dir.write_new(&key, &bytes))
        .await
        .map_err(internal)?
        .map_err(storage::io_error)?;
    sqlx::query("UPDATE images SET deleted_at=NULL WHERE id=$1")
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(internal)?;
    let mut row = row;
    row.deleted_at = None;
    Ok(row)
}
#[derive(Deserialize)]
struct ImageUpdate {
    original_name: String,
    album_id: Option<Uuid>,
}
async fn update_image(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<ImageUpdate>,
) -> ApiResult<StatusCode> {
    let user = authenticate(&headers, &state).await?;
    let name = input.original_name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(bad("图片名称须为 1–200 字符"));
    }
    let result=sqlx::query("UPDATE images SET original_name=$1,album_id=$2 WHERE id=$3 AND user_id=$4 AND deleted_at IS NULL AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM albums WHERE id=$2 AND user_id=$4))")
        .bind(name).bind(input.album_id).bind(id).bind(user.id).execute(&state.pool).await.map_err(internal)?;
    if result.rows_affected() == 0 {
        return Err(missing());
    }
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
struct VisibilityInput {
    is_public: bool,
}
async fn update_visibility(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<VisibilityInput>,
) -> ApiResult<StatusCode> {
    let user = authenticate(&headers, &state).await?;
    let result = sqlx::query(
        "UPDATE images SET is_public=$1 WHERE id=$2 AND user_id=$3 AND deleted_at IS NULL",
    )
    .bind(input.is_public)
    .bind(id)
    .bind(user.id)
    .execute(&state.pool)
    .await
    .map_err(internal)?;
    if result.rows_affected() == 0 {
        return Err(missing());
    }
    Ok(StatusCode::NO_CONTENT)
}
async fn remove_file_record(state: &AppState, row: &ImageRow) -> ApiResult<()> {
    file_jobs::remove_copies(state, row).await?;
    let location = storage::image_location(state, row).await?;
    let key = row.storage_key.clone();
    let thumb = thumbnails::key(row.id);
    tokio::task::spawn_blocking(move || {
        let dir = location.open()?;
        dir.remove(&key).map_err(storage::io_error)?;
        dir.remove(&thumb).map_err(storage::io_error)
    })
    .await
    .map_err(internal)??;
    sqlx::query("DELETE FROM images WHERE id=$1 AND deleted_at IS NOT NULL")
        .bind(row.id)
        .execute(&state.pool)
        .await
        .map_err(internal)?;
    Ok(())
}
async fn delete_image(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let user = authenticate(&headers, &state).await?;
    let _guard = state.uploads.lock().await;
    let row: ImageRow = sqlx::query_as(
        "UPDATE images SET deleted_at=NOW() WHERE id=$1 AND (user_id=$2 OR $3) RETURNING *",
    )
    .bind(id)
    .bind(user.id)
    .bind(user.is_admin)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal)?
    .ok_or_else(missing)?;
    remove_file_record(&state, &row).await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Serialize, sqlx::FromRow)]
struct Album {
    id: Uuid,
    name: String,
    description: Option<String>,
}
#[derive(Deserialize)]
struct AlbumInput {
    name: String,
    description: Option<String>,
}
async fn albums(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<Album>>> {
    let user = authenticate(&headers, &state).await?;
    Ok(Json(
        sqlx::query_as("SELECT id,name,description FROM albums WHERE user_id=$1 ORDER BY name,id")
            .bind(user.id)
            .fetch_all(&state.pool)
            .await
            .map_err(internal)?,
    ))
}
async fn create_album(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<AlbumInput>,
) -> ApiResult<(StatusCode, Json<Album>)> {
    let user = authenticate(&headers, &state).await?;
    let (name, description) = album_fields(&input)?;
    let row = sqlx::query_as(
        "INSERT INTO albums(id,user_id,name,description) VALUES($1,$2,$3,$4) RETURNING id,name,description",
    )
    .bind(Uuid::new_v4())
    .bind(user.id)
    .bind(name)
    .bind(description)
    .fetch_one(&state.pool)
    .await
    .map_err(internal)?;
    Ok((StatusCode::CREATED, Json(row)))
}
async fn update_album(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<AlbumInput>,
) -> ApiResult<Json<Album>> {
    let user = authenticate(&headers, &state).await?;
    let (name, description) = album_fields(&input)?;
    let row = sqlx::query_as(
        "UPDATE albums SET name=$3,description=$4 WHERE id=$1 AND user_id=$2 RETURNING id,name,description",
    )
    .bind(id)
    .bind(user.id)
    .bind(name)
    .bind(description)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal)?
    .ok_or_else(missing)?;
    Ok(Json(row))
}
fn album_fields(input: &AlbumInput) -> ApiResult<(&str, Option<&str>)> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(bad("相册名称须为 1–100 字符"));
    }
    let description = input
        .description
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if description.is_some_and(|value| value.chars().count() > 500) {
        return Err(bad("相册描述不能超过 500 字符"));
    }
    Ok((name, description))
}
async fn delete_album(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let user = authenticate(&headers, &state).await?;
    let mut tx = state.pool.begin().await.map_err(internal)?;
    let exists: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM albums WHERE id=$1 AND user_id=$2 FOR UPDATE")
            .bind(id)
            .bind(user.id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
    if exists.is_none() {
        return Err(missing());
    }
    sqlx::query("UPDATE images SET album_id=NULL WHERE album_id=$1 AND user_id=$2")
        .bind(id)
        .bind(user.id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("DELETE FROM albums WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn users(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(page): Query<Page>,
) -> ApiResult<Json<serde_json::Value>> {
    administrator(&headers, &state).await?;
    let rows: Vec<User> =
        sqlx::query_as("SELECT * FROM users ORDER BY created_at DESC,id DESC LIMIT 49 OFFSET $1")
            .bind(offset(page.page)?)
            .fetch_all(&state.pool)
            .await
            .map_err(internal)?;
    let has_more = rows.len() > 48;
    let mut result = Vec::new();
    for user in rows.into_iter().take(48) {
        let used: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(size_bytes),0)::bigint FROM images WHERE user_id=$1",
        )
        .bind(user.id)
        .fetch_one(&state.pool)
        .await
        .map_err(internal)?;
        result.push(serde_json::json!({"user":user,"used_bytes":used}));
    }
    Ok(Json(
        serde_json::json!({"items":result,"has_more":has_more}),
    ))
}
async fn create_user(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<Credentials>,
) -> ApiResult<StatusCode> {
    administrator(&headers, &state).await?;
    validate_credentials(&input.username, &input.password)?;
    let hash = hash_password(input.password, &state).await?;
    sqlx::query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)")
        .bind(Uuid::new_v4())
        .bind(input.username)
        .bind(hash)
        .execute(&state.pool)
        .await
        .map_err(db_error)?;
    Ok(StatusCode::CREATED)
}
#[derive(Deserialize)]
struct UserUpdate {
    quota_bytes: i64,
    disabled: bool,
    password: Option<String>,
}
async fn update_user(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<UserUpdate>,
) -> ApiResult<StatusCode> {
    administrator(&headers, &state).await?;
    if !(0..=9_000_000_000_000_000).contains(&input.quota_bytes) {
        return Err(bad("配额超出允许范围"));
    }
    let hash = match input.password {
        Some(password) => Some(hash_password(password, &state).await?),
        None => None,
    };
    let mut tx = state.pool.begin().await.map_err(internal)?;
    let user: User = sqlx::query_as("SELECT * FROM users WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    if user.is_admin && input.disabled {
        return Err(bad("不能禁用管理员账号"));
    }
    sqlx::query("UPDATE users SET quota_bytes=$1,disabled=$2,password_hash=COALESCE($3,password_hash),security_version=security_version+1 WHERE id=$4").bind(input.quota_bytes).bind(input.disabled).bind(&hash).bind(id).execute(&mut *tx).await.map_err(internal)?;
    if input.disabled || hash.is_some() {
        sqlx::query("DELETE FROM sessions WHERE user_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
fn image_id(key: &str) -> Option<Uuid> {
    if !key.contains('/') {
        return key.parse().ok();
    }
    let parts: Vec<_> = key.split('/').collect();
    if parts.len() != 4
        || parts[..3]
            .iter()
            .zip([4, 2, 2])
            .any(|(p, len)| p.len() != len || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let (id, ext) = parts[3].rsplit_once('.')?;
    if !["jpg", "png", "webp", "gif"].contains(&ext) {
        return None;
    }
    id.parse().ok()
}
async fn serve_image(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> ApiResult<Response> {
    let _guard = state.uploads.lock().await;
    let id = image_id(&key).ok_or_else(missing)?;
    let row: ImageRow = sqlx::query_as("SELECT * FROM images WHERE id=$1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    if key.contains('/') && key != row.storage_key {
        return Err(missing());
    }
    if !row.is_public {
        let user = authenticate(&headers, &state)
            .await
            .map_err(|_| missing())?;
        if user.id != row.user_id && !user.is_admin {
            return Err(missing());
        }
    }
    let bytes = storage::read_image(&state, &row).await?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_str(&row.content_type).map_err(internal)?,
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        bytes,
    )
        .into_response())
}
fn router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(
            state
                .origin
                .parse::<HeaderValue>()
                .expect("validated origin"),
        )
        .allow_credentials(true)
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([header::CONTENT_TYPE]);
    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/v1/settings", get(settings).patch(update_settings))
        .merge(security::routes())
        .route("/api/v1/auth/login", post(login))
        .route("/api/v1/auth/logout", post(logout))
        .route("/api/v1/auth/register", post(register))
        .route("/api/v1/me", get(me))
        .route("/api/v1/me/password", post(change_password))
        .route("/api/v1/images", get(list_images).post(upload_image))
        .route(
            "/api/v1/images/{id}",
            patch(update_image).delete(delete_image),
        )
        .route("/api/v1/albums", get(albums).post(create_album))
        .route("/api/v1/images/{id}/visibility", patch(update_visibility))
        .route(
            "/api/v1/albums/{id}",
            patch(update_album).delete(delete_album),
        )
        .route("/api/v1/admin/users", get(users).post(create_user))
        .route("/api/v1/admin/users/{id}", patch(update_user))
        .route("/i/{*key}", get(serve_image))
        .route(
            "/api/v1/admin/storage",
            get(management::storage).patch(management::set_storage),
        )
        .route(
            "/api/v1/storage-locations",
            get(storage::list).post(storage::add),
        )
        .route(
            "/api/v1/storage-locations/{id}/default",
            post(storage::select),
        )
        .route("/api/v1/file-jobs", get(file_jobs::list))
        .route("/api/v1/file-jobs/migrate", post(file_jobs::migrate))
        .route("/api/v1/file-jobs/{id}/retry", post(file_jobs::retry))
        .route("/api/v1/file-jobs/{id}/cleanup", post(file_jobs::cleanup))
        .route("/api/v1/file-jobs/{id}", get(file_jobs::details))
        .route("/api/v1/import-candidates", get(file_jobs::candidates))
        .route("/api/v1/import-albums/{id}", get(file_jobs::albums))
        .route("/api/v1/file-jobs/import", post(file_jobs::import))
        .route("/api/v1/images/{id}/thumbnail", get(thumbnails::serve))
        .route("/api/v1/admin/system", get(management::system))
        .route("/api/v1/admin/system/check", post(management::check))
        .route("/api/v1/admin/system/{action}", post(management::action))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES + 1024 * 1024))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            protect_origin,
        ))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
async fn bootstrap(state: &AppState) -> anyhow::Result<()> {
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(74190325)")
        .execute(&mut *tx)
        .await?;
    let admin: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE is_admin ORDER BY created_at LIMIT 1")
            .fetch_optional(&mut *tx)
            .await?;
    let admin = if let Some(id) = admin {
        id
    } else {
        let username = env::var("PICCOVE_ADMIN_USERNAME")
            .context("PICCOVE_ADMIN_USERNAME is required on first startup")?;
        let password = env::var("PICCOVE_ADMIN_PASSWORD")
            .context("PICCOVE_ADMIN_PASSWORD is required on first startup")?;
        validate_credentials(&username, &password).map_err(|e| anyhow::anyhow!(e.1))?;
        let hash = hash_password(password, state)
            .await
            .map_err(|e| anyhow::anyhow!(e.1))?;
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO users(id,username,password_hash,is_admin) VALUES($1,$2,$3,TRUE)")
            .bind(id)
            .bind(username)
            .bind(hash)
            .execute(&mut *tx)
            .await?;
        id
    };
    sqlx::query("UPDATE images SET user_id=$1 WHERE user_id IS NULL")
        .bind(admin)
        .execute(&mut *tx)
        .await?;
    sqlx::query("ALTER TABLE images ALTER COLUMN user_id SET NOT NULL")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let pending: Vec<ImageRow> =
        sqlx::query_as("SELECT * FROM images WHERE deleted_at IS NOT NULL")
            .fetch_all(&state.pool)
            .await?;
    for row in pending {
        remove_file_record(state, &row)
            .await
            .map_err(|e| anyhow::anyhow!(e.1))?;
    }
    Ok(())
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "piccove_api=info,tower_http=info".into()),
        )
        .init();
    let database_url = env::var("DATABASE_URL").context("DATABASE_URL is required")?;
    let public_base_url =
        env::var("PUBLIC_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:3001".into());
    let origin = env::var("CORS_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:5173".into());
    if ![&public_base_url, &origin]
        .iter()
        .all(|v| v.starts_with("https://") || v.starts_with("http://"))
    {
        bail!("URLs must use http or https");
    }
    origin.parse::<HeaderValue>()?;
    let contact_url = env::var("CONTACT_URL").ok().filter(|s| !s.is_empty());
    if contact_url
        .as_ref()
        .is_some_and(|v| !v.starts_with("https://") && !v.starts_with("mailto:"))
    {
        bail!("CONTACT_URL must use https:// or mailto:");
    }
    let mut upload_dir = PathBuf::from(env::var("UPLOAD_DIR").context("UPLOAD_DIR is required")?);
    if !upload_dir.is_absolute() {
        upload_dir = env::current_dir()?.join(upload_dir);
    }
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    let registered: Option<String> =
        sqlx::query_scalar("SELECT identity FROM storage_locations WHERE path=$1")
            .bind(upload_dir.to_str().context("UTF-8 UPLOAD_DIR required")?)
            .fetch_optional(&pool)
            .await?;
    if registered.is_none() {
        tokio::fs::create_dir_all(&upload_dir).await?;
    }
    let upload_directory = storage::Directory::open(&upload_dir)?;
    if registered
        .is_some_and(|identity| upload_directory.identity().ok().as_ref() != Some(&identity))
    {
        bail!("UPLOAD_DIR identity changed; restore the original mount before starting");
    }
    let storage_roots = env::var("PICCOVE_STORAGE_ROOTS")
        .map(|s| env::split_paths(&s).collect::<Vec<_>>())
        .unwrap_or_else(|_| vec![upload_dir.clone()]);
    if storage_roots.iter().any(|p| {
        !p.is_absolute()
            || p.parent().is_none()
            || p.components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
    }) {
        bail!("storage roots must be bounded absolute directories");
    }
    let import_dir = env::var("PICCOVE_IMPORT_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|path| -> anyhow::Result<storage::Location> {
            let dir = storage::Directory::open(std::path::Path::new(&path))?;
            Ok(storage::Location {
                id: Uuid::nil(),
                path,
                identity: dir.identity()?,
            })
        })
        .transpose()?;
    // One API process owns local storage; this also prevents startup cleanup racing an active upload.
    let lock = upload_directory
        .lock()
        .context("another PicCove process owns UPLOAD_DIR or lock is invalid")?;
    let security = security::Security::new(&origin)?;
    let state = Arc::new(AppState {
        pool,
        upload_dir,
        storage_roots,
        import_dir,
        thumbnails: Arc::new(Semaphore::new(2)),
        public_base_url,
        origin,
        contact_url,
        uploads: Mutex::new(()),
        passwords: Arc::new(Semaphore::new(4)),
        security,
    });
    storage::initialize(&state).await?;
    bootstrap(&state).await?;
    let (stop_jobs, stopped) = tokio::sync::watch::channel(false);
    let worker = tokio::spawn(file_jobs::worker(state.clone(), stopped));
    let listener = tokio::net::TcpListener::bind(
        env::var("LISTEN_ADDR").unwrap_or_else(|_| "127.0.0.1:3001".into()),
    )
    .await?;
    tracing::info!(address=%listener.local_addr()?,"PicCove API listening");
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    let _ = stop_jobs.send(true);
    worker.await??;
    drop(lock);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dated_image_links_and_legacy_ids() {
        let id = Uuid::new_v4();
        assert_eq!(image_id(&id.to_string()), Some(id));
        assert_eq!(image_id(&format!("2026/10/23/{id}.png")), Some(id));
        for key in [
            format!("../10/23/{id}.png"),
            format!("2026/10/{id}.png"),
            format!("2026/10/23/{id}.html"),
            format!("2026/10/23/{id}.png/extra"),
        ] {
            assert!(image_id(&key).is_none());
        }
    }
    #[test]
    fn credentials_and_limits() {
        assert!(validate_credentials("alice", "long-password-123").is_ok());
        for name in ["ab", "a/b", " auser", "用户"] {
            assert!(validate_credentials(name, "long-password-123").is_err());
        }
        assert!(validate_password("short").is_err());
        assert!(validate_password(&"x".repeat(129)).is_err());
        assert!(offset(Some(0)).is_err());
        assert_eq!(offset(Some(2)).unwrap(), 48);
        assert!(validate_image(b"not an image").is_err());
    }
    #[test]
    fn image_decode_and_corruption() {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 3)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        assert_eq!(
            validate_image(bytes.get_ref()).unwrap(),
            ("png", "image/png", 2, 3)
        );
        let mut broken = bytes.into_inner();
        broken.truncate(40);
        assert!(validate_image(&broken).is_err());
    }
    #[test]
    fn cookie_parsing_and_hashing() {
        let token = "a".repeat(64);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("other=1; piccove_session={token}").parse().unwrap(),
        );
        assert_eq!(session_token(&headers).unwrap(), token);
        assert_ne!(digest(&token), token);
        headers.insert(header::COOKIE, "piccove_session=bad".parse().unwrap());
        assert!(session_token(&headers).is_err());
    }
}
