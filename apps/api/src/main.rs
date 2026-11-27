mod account;
mod ai;
mod file_jobs;
mod management;
mod metadata;
mod security;
mod shares;
mod storage;
mod thumbnails;
mod tokens;

use account::valid_username;
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
    routing::{delete, get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use image::{ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{
    postgres::{PgPoolOptions, PgRow},
    FromRow, PgPool, Row,
};
use std::{
    collections::HashMap,
    env,
    io::Cursor,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, OwnedMutexGuard, Semaphore};
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
    storage_write: Mutex<()>,
    user_uploads: Mutex<HashMap<Uuid, Arc<Mutex<()>>>>,
    trust_proxy: bool,
    http: reqwest::Client,
    passwords: Arc<Semaphore>,
    security: security::Security,
}
impl AppState {
    async fn user_upload(&self, user_id: Uuid) -> OwnedMutexGuard<()> {
        let lock = {
            let mut users = self.user_uploads.lock().await;
            users.retain(|_, lock| Arc::strong_count(lock) > 1);
            users.entry(user_id).or_default().clone()
        };
        lock.lock_owned().await
    }
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
fn conflict(message: &str) -> ApiError {
    ApiError(StatusCode::CONFLICT, message.into())
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
    moderation_exempt: bool,
    violation_count: i32,
    content_ban: Option<String>,
    #[serde(skip_serializing)]
    password_hash: String,
    created_at: DateTime<Utc>,
    #[serde(skip_serializing)]
    security_version: i64,
    #[serde(rename = "totp_enabled", serialize_with = "serialize_present")]
    totp_secret: Option<String>,
    #[serde(skip)]
    totp_recovery_hashes: sqlx::types::Json<Vec<String>>,
}
fn serialize_present<S: serde::Serializer>(
    secret: &Option<String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_bool(secret.is_some())
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
    moderation_status: String,
    moderation_reason: String,
    moderation_hold: bool,
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
    storage::hash(value.as_bytes())
}
fn random_hex<const N: usize>() -> ApiResult<String> {
    let mut bytes = [0; N];
    openssl::rand::rand_bytes(&mut bytes).map_err(internal)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
async fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
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
    let token_upload = request.method() == Method::POST
        && request.uri().path() == "/api/v1/images"
        && tokens::bearer(request.headers()).is_some();
    if !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) && !token_upload
        && request
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            != Some(state.origin.as_str())
    {
        return forbidden().into_response();
    }
    next.run(request).await
}
fn client_ip(headers: &HeaderMap, peer: SocketAddr, state: &AppState) -> IpAddr {
    let ip = peer.ip();
    let private = match ip {
        IpAddr::V4(ip) => ip.is_private(),
        IpAddr::V6(ip) => ip.is_unique_local(),
    };
    if state.trust_proxy && (ip.is_loopback() || private) {
        if let Some(real) = headers
            .get("x-real-ip")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse().ok())
        {
            return real;
        }
    }
    ip
}
fn rate_limited() -> ApiError {
    ApiError(
        StatusCode::TOO_MANY_REQUESTS,
        "操作过于频繁，请稍后再试".into(),
    )
}
const RATE_UPSERT: &str = "INSERT INTO rate_limits(key, hits, expires_at)
    VALUES ($1, 1, NOW() + make_interval(secs => $2))
    ON CONFLICT (key) DO UPDATE
    SET hits = CASE WHEN rate_limits.expires_at <= NOW() THEN 1 ELSE rate_limits.hits + 1 END,
        expires_at = CASE WHEN rate_limits.expires_at <= NOW() THEN NOW() + make_interval(secs => $2) ELSE rate_limits.expires_at END
    RETURNING hits";
async fn rate(state: &AppState, key: String, limit: i32, seconds: i32) -> ApiResult<()> {
    let hits: i32 = sqlx::query_scalar(RATE_UPSERT)
        .bind(key)
        .bind(seconds as f64)
        .fetch_one(&state.pool)
        .await
        .map_err(internal)?;
    if hits == 1 {
        // A concurrent hit can renew a selected window before DELETE obtains its row lock.
        sqlx::query("DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at < NOW() LIMIT 64) AND expires_at < NOW()")
            .execute(&state.pool).await.map_err(internal)?;
    }
    if hits > limit {
        return Err(rate_limited());
    }
    Ok(())
}
fn validate_credentials(username: &str, password: &str) -> ApiResult<()> {
    if !valid_username(username) {
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
            .map_err(|e| match e {
                argon2::password_hash::Error::Password => unauthorized(),
                _ => internal(e),
            })
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
    headers: HeaderMap,
    Json(input): Json<Credentials>,
) -> ApiResult<Response> {
    validate_credentials(&input.username, &input.password)?;
    let ip = client_ip(&headers, peer, &state);
    rate(&state, format!("login:ip:{ip}"), 20, 60).await?;
    rate(&state, "login:global".into(), 120, 60).await?;
    let failure_key = format!("login:fail:{}", input.username.to_ascii_lowercase());
    let limited: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM rate_limits WHERE key=$1 AND expires_at>NOW() AND hits>=10)",
    )
    .bind(&failure_key)
    .fetch_one(&state.pool)
    .await
    .map_err(internal)?;
    if limited {
        return Err(rate_limited());
    }
    let failed = async |error| match rate(&state, failure_key.clone(), 10, 300).await {
        Ok(()) | Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _)) => error,
        Err(db) => db,
    };
    let Some(user) =
        sqlx::query_as::<_, User>("SELECT * FROM users WHERE username=$1 AND NOT disabled")
            .bind(&input.username)
            .fetch_optional(&state.pool)
            .await
            .map_err(internal)?
    else {
        return Err(failed(unauthorized()).await);
    };
    match verify_password(input.password, user.password_hash.clone(), &state).await {
        Err(e @ ApiError(StatusCode::UNAUTHORIZED, _)) => return Err(failed(e).await),
        result => result?,
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut tx = state.pool.begin().await.map_err(internal)?;
    let current: User = sqlx::query_as("SELECT * FROM users WHERE id=$1 FOR UPDATE")
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    if current.disabled {
        drop(tx);
        return Err(failed(unauthorized()).await);
    }
    if current.password_hash != user.password_hash
        || current.security_version != user.security_version
    {
        return Err(unauthorized());
    }
    match security::verify_totp(&mut tx, user.id, &input.code).await {
        Err(e @ ApiError(StatusCode::BAD_REQUEST, _)) => {
            drop(tx);
            return Err(failed(e).await);
        }
        result => result?,
    }
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
    headers: HeaderMap,
    Json(input): Json<Credentials>,
) -> ApiResult<StatusCode> {
    validate_credentials(&input.username, &input.password)?;
    let ip = client_ip(&headers, peer, &state);
    rate(&state, format!("register:{ip}"), 5, 3600).await?;
    rate(&state, "register:global".into(), 20, 3600).await?;
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
}
#[derive(Deserialize)]
struct ImageListQuery {
    page: Option<i64>,
    album_id: Option<Uuid>,
    all: Option<bool>,
    content_hash: Option<String>,
    ids: Option<String>,
    expected_user_id: Option<Uuid>,
    q: Option<String>,
    is_public: Option<bool>,
    moderation_status: Option<String>,
    user_id: Option<Uuid>,
}
#[derive(Deserialize)]
struct AdminListQuery {
    page: Option<i64>,
    q: Option<String>,
    status: Option<String>,
}
fn offset(page: Option<i64>) -> ApiResult<i64> {
    let page = page.unwrap_or(1);
    if !(1..=1_000_000).contains(&page) {
        return Err(bad("页码无效"));
    }
    Ok((page - 1) * 48)
}
fn search_pattern(q: Option<&str>, max_chars: Option<usize>) -> ApiResult<Option<String>> {
    let Some(term) = q.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if max_chars.is_some_and(|max| term.chars().count() > max) {
        return Err(bad("搜索词过长"));
    }
    let escaped = term
        .replace('\\', r"\\")
        .replace('%', r"\%")
        .replace('_', r"\_");
    Ok(Some(format!("%{escaped}%")))
}
fn moderation_filter(status: Option<&str>, include_image_states: bool) -> ApiResult<Option<&str>> {
    match status.map(str::trim) {
        None | Some("") => Ok(None),
        value @ Some(
            "pending" | "running" | "passed" | "blocked" | "review" | "failed" | "exempt",
        ) => Ok(value),
        value @ Some("unreviewed") if include_image_states => Ok(value),
        _ => Err(bad("审核状态筛选无效")),
    }
}
fn list_response(
    rows: &[PgRow],
    start: i64,
    item: impl Fn(&PgRow) -> Result<serde_json::Value, sqlx::Error>,
) -> ApiResult<Json<serde_json::Value>> {
    // The count is LEFT JOINed to the page, so even an empty page returns one row.
    let total: i64 = rows[0].try_get("total").map_err(internal)?;
    let items = if start < total {
        rows.iter()
            .map(item)
            .collect::<Result<Vec<_>, _>>()
            .map_err(internal)?
    } else {
        Vec::new()
    };
    Ok(Json(
        serde_json::json!({"items":items,"has_more":start + 48 < total,"total":total}),
    ))
}
async fn list_images(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ImageListQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let user = authenticate(&headers, &state).await?;
    if query.expected_user_id.is_some_and(|id| id != user.id) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "账号已切换，请重新打开工作台".into(),
        ));
    }
    let all = query.all.unwrap_or(false);
    let owner = match (all, query.user_id) {
        (true, owner) if user.is_admin => owner,
        (false, None) => Some(user.id),
        _ => return Err(forbidden()),
    };
    if query
        .content_hash
        .as_ref()
        .is_some_and(|hash| hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(bad("图片摘要无效"));
    }
    let ids = query
        .ids
        .as_ref()
        .map(|ids| {
            if ids.len() > 48 * 37 || ids.split(',').count() > 48 {
                return Err(bad("一次最多查询 48 张图片"));
            }
            ids.split(',')
                .map(|id| Uuid::parse_str(id).map_err(|_| bad("图片 ID 无效")))
                .collect::<ApiResult<Vec<_>>>()
        })
        .transpose()?;
    let q = search_pattern(query.q.as_deref(), Some(200))?;
    let status = moderation_filter(query.moderation_status.as_deref(), true)?;
    // Reconcile only after an earlier upload has finished committing its file.
    let _upload = if let (Some(_), Some(uid)) = (&query.content_hash, owner) {
        Some(
            tokio::time::timeout(Duration::from_secs(10), state.user_upload(uid))
                .await
                .map_err(|_| {
                    ApiError(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "上次上传仍在处理，请稍后重试".into(),
                    )
                })?,
        )
    } else {
        None
    };
    let start = offset(query.page)?;
    let rows = sqlx::query(
        r"WITH filtered AS NOT MATERIALIZED (
              SELECT * FROM images
              WHERE ($1::uuid IS NULL OR user_id = $1)
                AND ($2::uuid IS NULL OR album_id = $2)
                AND ($3::text IS NULL OR ((content_hash = LOWER($3) OR source_hash = LOWER($3)) AND deleted_at IS NULL))
                AND ($4::uuid[] IS NULL OR id = ANY($4))
                AND ($4::uuid[] IS NOT NULL OR deleted_at IS NULL)
                AND ($5::text IS NULL OR original_name ILIKE $5 ESCAPE E'\\')
                AND ($6::boolean IS NULL OR is_public = $6)
                AND ($7::text IS NULL OR moderation_status = $7)
          )
          SELECT p.*, u.username, c.total
          FROM (SELECT COUNT(*) AS total FROM filtered) c
          LEFT JOIN (SELECT * FROM filtered ORDER BY created_at DESC, id DESC LIMIT 48 OFFSET $8) p ON TRUE
          LEFT JOIN users u ON u.id = p.user_id AND $9
          ORDER BY p.created_at DESC, p.id DESC",
    )
    .bind(owner)
    .bind(query.album_id)
    .bind(query.content_hash)
    .bind(ids)
    .bind(q)
    .bind(query.is_public)
    .bind(status)
    .bind(start)
    .bind(all)
    .fetch_all(&state.pool)
    .await
    .map_err(internal)?;
    list_response(&rows, start, |row| {
        let mut image = image_dto(ImageRow::from_row(row)?, &state);
        if all {
            image["username"] = row.try_get::<String, _>("username")?.into();
        }
        Ok(image)
    })
}
struct CheckedImage {
    ext: &'static str,
    mime: &'static str,
    width: u32,
    height: u32,
    hash: String,
    source_hash: String,
}
async fn validate_image(raw: Bytes, strip_metadata: bool) -> ApiResult<(Bytes, CheckedImage)> {
    tokio::task::spawn_blocking(move || {
        let invalid = |message: &str| {
            bad(if strip_metadata {
                metadata::STRIP_ERROR
            } else {
                message
            })
        };
        if raw.is_empty() || raw.len() > MAX_UPLOAD_BYTES {
            return Err(invalid("图片大小须为 1 字节至 10 MiB"));
        }
        let source_hash = storage::hash(&raw);
        let bytes = if strip_metadata {
            Bytes::from(metadata::strip(&raw).ok_or_else(|| bad(metadata::STRIP_ERROR))?)
        } else {
            raw
        };
        let format = image::guess_format(&bytes).map_err(|_| invalid("无效图片"))?;
        let (ext, mime) = match format {
            ImageFormat::Jpeg => ("jpg", "image/jpeg"),
            ImageFormat::Png => ("png", "image/png"),
            ImageFormat::WebP => ("webp", "image/webp"),
            ImageFormat::Gif => ("gif", "image/gif"),
            _ => return Err(invalid("仅支持 JPEG、PNG、WebP、GIF")),
        };
        let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(16000);
        limits.max_image_height = Some(16000);
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        let image = reader
            .decode()
            .map_err(|_| invalid("图片损坏或解码内存超出限制"))?;
        let checked = CheckedImage {
            ext,
            mime,
            width: image.width(),
            height: image.height(),
            hash: if strip_metadata {
                storage::hash(&bytes)
            } else {
                source_hash.clone()
            },
            source_hash,
        };
        Ok((bytes, checked))
    })
    .await
    .map_err(internal)?
}
#[derive(Deserialize)]
struct UploadOptions {
    private: Option<bool>,
    #[serde(default)]
    strip_metadata: bool,
    album_id: Option<Uuid>,
    expected_user_id: Option<Uuid>,
}
async fn upload_image(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(options): Query<UploadOptions>,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<serde_json::Value>)> {
    let (user, default_album, default_public) = tokens::upload_auth(&headers, &state).await?;
    if options.expected_user_id.is_some_and(|id| id != user.id) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "账号已切换，请重新打开工作台".into(),
        ));
    }
    ai::can_create(&user)?;
    rate(&state, format!("upload:{}", user.id), 60, 60).await?;
    let upload_guard = state.user_upload(user.id).await;
    let (original_name, bytes) = tokio::time::timeout(Duration::from_secs(60), async {
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
        upload.ok_or_else(|| bad("缺少图片"))
    })
    .await
    .map_err(|_| bad("上传超时，请重试"))??;
    let (bytes, checked) = validate_image(bytes, options.strip_metadata).await?;
    // Older images acquire their digest lazily; duplicate uploads retain the original visibility and album.
    let candidates: Vec<ImageRow> = sqlx::query_as(
        "SELECT * FROM images WHERE user_id=$1 AND size_bytes=$2 AND deleted_at IS NULL AND (content_hash=$3 OR content_hash IS NULL) ORDER BY created_at,id",
    )
    .bind(user.id)
    .bind(bytes.len() as i64)
    .bind(&checked.hash)
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
            // A content match can carry one distinct original hash while both remain searchable.
            let source_alias = (existing_hash == checked.hash
                && checked.source_hash != checked.hash)
                .then_some(&checked.source_hash);
            let current: Option<ImageRow> = sqlx::query_as(
                "UPDATE images SET content_hash=$1,source_hash=COALESCE($3,source_hash,$1)
                 WHERE id=$2 AND deleted_at IS NULL
                   AND ($3::text IS NULL OR source_hash IS NULL OR source_hash IN ($1,$3)) RETURNING *",
            )
            .bind(&existing_hash)
            .bind(existing.id)
            .bind(source_alias)
            .fetch_optional(&state.pool)
            .await
            .map_err(internal)?;
            if let Some(existing) = current.filter(|_| existing_hash == checked.hash) {
                let mut result = image_dto(existing, &state);
                result["duplicate"] = serde_json::json!(true);
                return Ok((StatusCode::OK, Json(result)));
            }
        }
    }
    // Finish the accepted write and hold its reconciliation lock even if the HTTP client disconnects.
    tokio::spawn(async move {
        let _upload = upload_guard;
        let _write = state.storage_write.lock().await;
        let row = store_image(
            &state,
            user.id,
            original_name,
            bytes,
            checked,
            options.private.map_or(default_public, |private| !private),
            options.album_id.or(default_album),
            Uuid::new_v4(),
            None,
            None,
        )
        .await?;
        Ok((StatusCode::CREATED, Json(image_dto(row, &state))))
    })
    .await
    .map_err(internal)?
}
// Callers hold storage_write from the space check through activation or cleanup.
async fn store_image(
    state: &AppState,
    user_id: Uuid,
    original_name: String,
    bytes: Bytes,
    checked: CheckedImage,
    is_public: bool,
    album_id: Option<Uuid>,
    id: Uuid,
    import_key: Option<String>,
    generation: Option<(Uuid, &str, &str)>,
) -> ApiResult<ImageRow> {
    let CheckedImage {
        ext,
        mime,
        width,
        height,
        hash,
        source_hash,
    } = checked;
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
    ai::can_create(&current)?;
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
    let storage_key = format!("{}/{id}.{ext}", Utc::now().format("%Y/%m/%d"));
    check_album(&mut tx, user_id, album_id).await?;
    // Keep a pending row until the file is durable; interrupted uploads remain identifiable for cleanup.
    let row: ImageRow=sqlx::query_as("INSERT INTO images(id,user_id,original_name,storage_key,content_type,size_bytes,width,height,deleted_at,is_public,storage_root,album_id,import_key,content_hash,source_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10,$11,$12,$13,$14) RETURNING *")
        .bind(id).bind(user_id).bind(original_name).bind(storage_key).bind(mime).bind(bytes.len() as i64).bind(width as i32).bind(height as i32).bind(is_public).bind(&location.path).bind(album_id).bind(import_key).bind(&hash).bind(source_hash).fetch_one(&mut *tx).await.map_err(internal)?;
    let key = row.storage_key.clone();
    let mut written = None;
    let mut committing = false;
    let result = async {
        tx.commit().await.map_err(internal)?;
        written = Some(
            tokio::task::spawn_blocking(move || dir.write_new(&key, &bytes).map(|()| dir))
                .await
                .map_err(internal)?
                .map_err(storage::io_error)?,
        );
        let mut tx = state.pool.begin().await.map_err(internal)?;
        ai::enqueue_review(&mut tx, &current, &row, &hash).await?;
        let active = sqlx::query_as("UPDATE images SET deleted_at=NULL WHERE id=$1 RETURNING *")
            .bind(id)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
        if let Some((message, response_id, text)) = generation {
            ai::complete_generation(&mut tx, message, response_id, text, Some(id)).await?;
        }
        committing = true;
        tx.commit().await.map_err(internal)?;
        Ok(active)
    }
    .await;
    if result.is_err() {
        let deleted = match sqlx::query("DELETE FROM images WHERE id=$1 AND deleted_at IS NOT NULL")
            .bind(id)
            .execute(&state.pool)
            .await
        {
            Ok(r) => r.rows_affected() == 1,
            Err(e) => {
                tracing::warn!(image_id=%id, error=%e, "pending image cleanup deferred");
                false
            }
        };
        // A lost COMMIT reply can mean the image and its message are already live.
        if let Some(dir) = written.filter(|_| !committing || deleted) {
            if let Err(e) = dir.remove(&row.storage_key) {
                tracing::warn!(image_id=%id, key=%row.storage_key, error=%e, "failed to remove unused image file");
            }
        }
        if let Err(e) = sqlx::query("DELETE FROM image_reviews r WHERE r.user_id=$1 AND r.content_hash=$2 AND NOT EXISTS (SELECT 1 FROM images i WHERE i.user_id=r.user_id AND i.content_hash=r.content_hash)")
            .bind(user_id).bind(&hash).execute(&state.pool).await {
            tracing::warn!(image_id=%id, error=%e, "orphan review cleanup failed");
        }
    }
    result
}
#[derive(Deserialize)]
struct ImageUpdate {
    original_name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_album_id")]
    album_id: Option<Option<Uuid>>,
}
fn deserialize_album_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<Uuid>>, D::Error> {
    Option::<Uuid>::deserialize(deserializer).map(Some)
}
async fn update_image(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<ImageUpdate>,
) -> ApiResult<StatusCode> {
    let user = authenticate(&headers, &state).await?;
    let name = input.original_name.as_deref().map(str::trim);
    if name.is_none() && input.album_id.is_none() {
        return Err(bad("缺少修改内容"));
    }
    if name.is_some_and(|name| name.is_empty() || name.chars().count() > 200) {
        return Err(bad("图片名称须为 1–200 字符"));
    }
    let result = sqlx::query(
        "UPDATE images SET original_name = COALESCE($1, original_name),
                           album_id = CASE WHEN $2 THEN $3::uuid ELSE album_id END
         WHERE id = $4 AND user_id = $5 AND deleted_at IS NULL
           AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM albums WHERE id = $3 AND user_id = $5))",
    )
    .bind(name)
    .bind(input.album_id.is_some())
    .bind(input.album_id.flatten())
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
    let mut tx = state.pool.begin().await.map_err(internal)?;
    let current: User = sqlx::query_as("SELECT * FROM users WHERE id=$1 FOR UPDATE")
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    if current.disabled {
        return Err(unauthorized());
    }
    if input.is_public {
        ai::can_create(&current)?;
    }
    let row: ImageRow =
        sqlx::query_as("SELECT * FROM images WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL")
            .bind(id)
            .bind(user.id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?
            .ok_or_else(missing)?;
    if input.is_public && ai::restricted(&row.moderation_status) {
        return Err(bad("图片被审核限制，不能公开"));
    }
    let result = sqlx::query(
        "UPDATE images SET is_public=$1 WHERE id=$2 AND user_id=$3 AND deleted_at IS NULL",
    )
    .bind(input.is_public)
    .bind(id)
    .bind(user.id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    if result.rows_affected() == 0 {
        return Err(missing());
    }
    tx.commit().await.map_err(internal)?;
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
    if !delete_owned_image(&state, &user, id).await? {
        return Err(missing());
    }
    Ok(StatusCode::NO_CONTENT)
}
async fn delete_owned_image(state: &AppState, user: &User, id: Uuid) -> ApiResult<bool> {
    let _guard = state.storage_write.lock().await;
    let row: Option<ImageRow> = sqlx::query_as(
        "UPDATE images SET deleted_at=NOW() WHERE id=$1 AND (user_id=$2 OR $3) RETURNING *",
    )
    .bind(id)
    .bind(user.id)
    .bind(user.is_admin)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal)?;
    let Some(row) = row else { return Ok(false) };
    remove_file_record(state, &row).await?;
    Ok(true)
}
async fn check_album(
    conn: &mut sqlx::PgConnection,
    user: Uuid,
    album: Option<Uuid>,
) -> ApiResult<()> {
    if let Some(id) = album {
        sqlx::query("SELECT id FROM albums WHERE id=$1 AND user_id=$2 FOR KEY SHARE")
            .bind(id)
            .bind(user)
            .fetch_optional(conn)
            .await
            .map_err(internal)?
            .ok_or_else(|| bad("相册不属于所选用户"))?;
    }
    Ok(())
}
#[derive(Deserialize)]
struct BatchImages {
    ids: Vec<Uuid>,
    action: String,
    album_id: Option<Uuid>,
    is_public: Option<bool>,
}
async fn batch_images(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(mut input): Json<BatchImages>,
) -> ApiResult<Json<serde_json::Value>> {
    let user = authenticate(&headers, &state).await?;
    input.ids.sort_unstable();
    input.ids.dedup();
    if !(1..=48).contains(&input.ids.len()) {
        return Err(bad("每次请选择 1–48 张图片"));
    }
    let processed = match input.action.as_str() {
        "move" => {
            let mut tx = state.pool.begin().await.map_err(internal)?;
            check_album(&mut tx, user.id, input.album_id).await?;
            let updated = sqlx::query("UPDATE images SET album_id=$1 WHERE user_id=$2 AND id=ANY($3) AND deleted_at IS NULL")
                .bind(input.album_id).bind(user.id).bind(&input.ids).execute(&mut *tx).await.map_err(internal)?;
            tx.commit().await.map_err(internal)?;
            updated.rows_affected()
        }
        "visibility" => {
            let public = input.is_public.ok_or_else(|| bad("缺少 is_public"))?;
            if public {
                ai::can_create(&user)?;
            }
            sqlx::query("UPDATE images SET is_public=$1 WHERE user_id=$2 AND id=ANY($3) AND deleted_at IS NULL
                         AND (NOT $1 OR moderation_status NOT IN ('blocked','review'))")
                .bind(public).bind(user.id).bind(&input.ids).execute(&state.pool).await.map_err(internal)?.rows_affected()
        }
        "delete" => {
            let mut deleted = 0;
            for &id in &input.ids {
                deleted += u64::from(delete_owned_image(&state, &user, id).await?);
            }
            deleted
        }
        _ => return Err(bad("不支持的批量操作")),
    };
    Ok(Json(
        serde_json::json!({"processed":processed,"skipped":input.ids.len() as u64 - processed}),
    ))
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
#[derive(Serialize, sqlx::FromRow)]
struct AlbumSummary {
    id: Uuid,
    name: String,
    description: Option<String>,
    image_count: i64,
    cover_id: Option<Uuid>,
}
async fn albums(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<AlbumSummary>>> {
    let user = authenticate(&headers, &state).await?;
    Ok(Json(
        sqlx::query_as("SELECT a.id,a.name,a.description,COUNT(i.id) AS image_count, (ARRAY_AGG(i.id ORDER BY i.created_at DESC,i.id DESC) FILTER (WHERE $2 OR i.moderation_status NOT IN ('blocked','review')))[1] AS cover_id FROM albums a LEFT JOIN images i ON i.album_id=a.id AND i.user_id=a.user_id AND i.deleted_at IS NULL WHERE a.user_id=$1 GROUP BY a.id ORDER BY a.name,a.id")
            .bind(user.id)
            .bind(user.is_admin)
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
async fn admin_overview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    administrator(&headers, &state).await?;
    let overview = sqlx::query_scalar(
        "SELECT to_jsonb(overview) FROM (
             SELECT u.*, i.*, s.registration_open,
                    (SELECT COUNT(*) FROM image_reviews WHERE status = 'review') AS reviews_pending,
                    (SELECT COUNT(*) FROM file_jobs WHERE status IN ('queued','running')) AS jobs_active
             FROM (SELECT COUNT(*) AS users_total,
                          COUNT(*) FILTER (WHERE disabled) AS users_disabled,
                          COUNT(*) FILTER (WHERE content_ban IS NOT NULL) AS users_banned
                   FROM users) u
             CROSS JOIN (SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL) AS images_total,
                                COUNT(*) FILTER (WHERE deleted_at IS NULL AND is_public) AS images_public,
                                COALESCE(SUM(size_bytes) FILTER (WHERE deleted_at IS NULL), 0)::bigint AS used_bytes
                         FROM images) i
             CROSS JOIN settings s
         ) overview",
    )
    .fetch_one(&state.pool)
    .await
    .map_err(internal)?;
    Ok(Json(overview))
}
fn user_status_condition(status: Option<&str>) -> ApiResult<&'static str> {
    match status.map(str::trim) {
        None | Some("") => Ok("TRUE"),
        Some("active") => Ok("NOT disabled AND content_ban IS NULL"),
        Some("disabled") => Ok("disabled"),
        Some("banned") => Ok("content_ban IS NOT NULL"),
        _ => Err(bad("用户状态筛选无效")),
    }
}
async fn users(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AdminListQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    administrator(&headers, &state).await?;
    let start = offset(query.page)?;
    let q = search_pattern(query.q.as_deref(), Some(100))?;
    let status = user_status_condition(query.status.as_deref())?;
    let rows = sqlx::query(&format!(
        r"WITH filtered AS NOT MATERIALIZED (
              SELECT * FROM users WHERE ({status}) AND ($1::text IS NULL OR username ILIKE $1 ESCAPE E'\\')
          ), page AS (
              SELECT * FROM filtered ORDER BY created_at DESC, id DESC LIMIT 48 OFFSET $2
          ), usage AS (
              SELECT i.user_id, SUM(i.size_bytes)::bigint AS used_bytes
              FROM images i JOIN page p ON p.id = i.user_id GROUP BY i.user_id
          )
          SELECT p.*, c.total, COALESCE(usage.used_bytes, 0) AS used_bytes
          FROM (SELECT COUNT(*) AS total FROM filtered) c
          LEFT JOIN page p ON TRUE
          LEFT JOIN usage ON usage.user_id = p.id
          ORDER BY p.created_at DESC, p.id DESC",
    ))
    .bind(q)
    .bind(start)
    .fetch_all(&state.pool)
    .await
    .map_err(internal)?;
    list_response(&rows, start, |row| {
        let user = User::from_row(row)?;
        let used: i64 = row.try_get("used_bytes")?;
        Ok(serde_json::json!({"user":user,"used_bytes":used}))
    })
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
    let changed = input.disabled != user.disabled || hash.is_some();
    sqlx::query("UPDATE users SET quota_bytes=$1,disabled=$2,password_hash=COALESCE($3,password_hash),security_version=security_version+$5 WHERE id=$4").bind(input.quota_bytes).bind(input.disabled).bind(&hash).bind(id).bind(i64::from(changed)).execute(&mut *tx).await.map_err(internal)?;
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
    ai::authorize_image(&state, &headers, &row).await?;
    cached_image(
        &headers,
        format!("\"img-{id}\""),
        &row.content_type,
        storage::read_image(&state, &row),
    )
    .await
}
fn etag_matches(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .any(|tag| tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == etag)
}
async fn cached_image(
    request: &HeaderMap,
    etag: String,
    mime: &str,
    load: impl std::future::Future<Output = ApiResult<Vec<u8>>>,
) -> ApiResult<Response> {
    let cache = [
        (header::ETAG, etag.as_str()),
        (header::CACHE_CONTROL, "private, no-cache"),
    ];
    if etag_matches(request, &etag) {
        return Ok((StatusCode::NOT_MODIFIED, cache).into_response());
    }
    Ok((
        cache,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_str(mime).map_err(internal)?,
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        load.await?,
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
    let origin = middleware::from_fn_with_state(state.clone(), protect_origin);
    let sensitive = Router::new()
        .route("/api/v1/me/totp/start", post(security::totp_start))
        .route("/api/v1/me/totp/confirm", post(security::totp_confirm))
        .route("/api/v1/me/totp/recovery", post(security::totp_recovery))
        .route("/api/v1/me/tokens", post(tokens::create))
        .route(
            "/api/v1/images/{id}/shares",
            get(shares::list).post(shares::create),
        )
        .route_layer(origin.clone())
        .route_layer(middleware::map_response(no_store));
    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/v1/settings", get(settings).patch(update_settings))
        .merge(security::routes())
        .merge(ai::routes())
        .route("/api/v1/me/tokens", get(tokens::list))
        .route("/api/v1/me/tokens/{id}", delete(tokens::remove))
        .route(
            "/api/v1/images/{id}/shares/{share_id}",
            delete(shares::revoke),
        )
        .route("/s/{token}", get(shares::serve))
        .route("/api/v1/auth/login", post(login))
        .route("/api/v1/auth/logout", post(logout))
        .route("/api/v1/auth/register", post(register))
        .route("/api/v1/me", get(me))
        .route("/api/v1/me/password", post(change_password))
        .route("/api/v1/images", get(list_images).post(upload_image))
        .route("/api/v1/images/batch", post(batch_images))
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
        .route("/api/v1/admin/overview", get(admin_overview))
        .route("/api/v1/admin/users", get(users).post(create_user))
        .route("/api/v1/admin/users/{id}", patch(update_user))
        .route("/i/{*key}", get(serve_image))
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
        .layer(origin)
        .merge(sensitive)
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES + 1024 * 1024))
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
        if let Err(e) = remove_file_record(state, &row).await {
            tracing::warn!(image_id = %row.id, error = %e.1, "pending image cleanup deferred");
        }
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
        storage_write: Mutex::new(()),
        user_uploads: Mutex::default(),
        trust_proxy: env::var("PICCOVE_TRUST_PROXY")
            .is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true")),
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .user_agent("PicCove")
            .build()?,
        passwords: Arc::new(Semaphore::new(4)),
        security,
    });
    storage::initialize(&state).await?;
    bootstrap(&state).await?;
    let (stop_jobs, stopped) = tokio::sync::watch::channel(false);
    let worker = tokio::spawn(file_jobs::worker(state.clone(), stopped.clone()));
    ai::recover(&state).await?;
    let review_worker = tokio::spawn(ai::review_worker(state.clone(), stopped.clone()));
    let generation_worker = tokio::spawn(ai::generation_worker(state.clone(), stopped));
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
    review_worker.await?;
    generation_worker.await?;
    drop(lock);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn test_state() -> AppState {
        AppState {
            pool: PgPoolOptions::new()
                .connect_lazy("postgres://localhost/test")
                .unwrap(),
            upload_dir: PathBuf::new(),
            storage_roots: Vec::new(),
            import_dir: None,
            thumbnails: Arc::new(Semaphore::new(2)),
            public_base_url: String::new(),
            origin: String::new(),
            contact_url: None,
            storage_write: Mutex::default(),
            user_uploads: Mutex::default(),
            trust_proxy: false,
            http: reqwest::Client::new(),
            passwords: Arc::new(Semaphore::new(4)),
            security: security::Security::new("http://127.0.0.1").unwrap(),
        }
    }
    #[tokio::test]
    async fn client_ip_requires_an_enabled_private_proxy_and_a_single_valid_ip() {
        let mut state = test_state();
        let mut headers = HeaderMap::new();
        let real: IpAddr = "2001:db8::5".parse().unwrap();
        headers.insert("x-real-ip", "2001:db8::5".parse().unwrap());
        for (addr, trusted) in [
            ("127.0.0.2", true),
            ("10.0.0.1", true),
            ("172.31.255.255", true),
            ("192.168.0.2", true),
            ("::1", true),
            ("fc00::1", true),
            ("fdff::1", true),
            ("172.32.0.1", false),
            ("203.0.113.7", false),
            ("fe80::1", false),
            ("2001:db8::1", false),
        ] {
            let peer = SocketAddr::new(addr.parse().unwrap(), 1234);
            for enabled in [false, true] {
                state.trust_proxy = enabled;
                assert_eq!(
                    client_ip(&headers, peer, &state),
                    if enabled && trusted { real } else { peer.ip() }
                );
            }
        }
        let peer = "127.0.0.1:1234".parse::<SocketAddr>().unwrap();
        headers.insert("x-real-ip", "192.0.2.1, 10.0.0.1".parse().unwrap());
        assert_eq!(client_ip(&headers, peer, &state), peer.ip());
        assert_eq!(client_ip(&HeaderMap::new(), peer, &state), peer.ip());
    }
    #[tokio::test]
    async fn reconciliation_waits_only_for_its_owner_and_releases_idle_keys() {
        let state = test_state();
        let owner = Uuid::new_v4();
        let other = Uuid::new_v4();
        let uploading = state.user_upload(owner).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(10), state.user_upload(owner))
                .await
                .is_err()
        );
        drop(
            tokio::time::timeout(Duration::from_secs(1), state.user_upload(other))
                .await
                .unwrap(),
        );
        drop(uploading);
        let _next = state.user_upload(owner).await;
        assert_eq!(state.user_uploads.lock().await.len(), 1);
    }
    #[test]
    fn search_escapes_literals_and_counts_trimmed_characters() {
        assert_eq!(search_pattern(None, Some(100)).unwrap(), None);
        assert_eq!(search_pattern(Some(" \t "), None).unwrap(), None);
        assert_eq!(
            search_pattern(Some(r"  A\B%_图  "), None)
                .unwrap()
                .as_deref(),
            Some(r"%A\\B\%\_图%")
        );
        for max in [100, 200] {
            let term = "图".repeat(max);
            assert!(search_pattern(Some(&format!(" {term} ")), Some(max)).is_ok());
            let longer = format!("{term}图");
            assert_eq!(
                search_pattern(Some(&longer), Some(max)).unwrap_err().1,
                "搜索词过长"
            );
            assert!(search_pattern(Some(&longer), None).is_ok());
        }
    }
    #[test]
    fn image_patch_distinguishes_omitted_null_and_uuid() {
        use serde_json::{from_value, json};
        let id = Uuid::new_v4();
        let empty: ImageUpdate = from_value(json!({})).unwrap();
        assert_eq!((empty.original_name, empty.album_id), (None, None));
        let rename: ImageUpdate = from_value(json!({"original_name":"new"})).unwrap();
        assert_eq!(
            (rename.original_name.as_deref(), rename.album_id),
            (Some("new"), None)
        );
        let clear: ImageUpdate = from_value(json!({"album_id":null})).unwrap();
        assert_eq!((clear.original_name, clear.album_id), (None, Some(None)));
        let move_only: ImageUpdate = from_value(json!({"album_id":id})).unwrap();
        assert_eq!(
            (move_only.original_name, move_only.album_id),
            (None, Some(Some(id)))
        );
        let both: ImageUpdate = from_value(json!({"original_name":"new","album_id":id})).unwrap();
        assert_eq!(
            (both.original_name.as_deref(), both.album_id),
            (Some("new"), Some(Some(id)))
        );
        assert!(from_value::<ImageUpdate>(json!({"album_id":"invalid"})).is_err());
    }
    #[test]
    fn user_status_filters() {
        assert_eq!(
            user_status_condition(Some(" ")).unwrap(),
            user_status_condition(None).unwrap()
        );
        for status in ["active", "disabled", "banned"] {
            assert!(user_status_condition(Some(&format!(" {status} "))).is_ok());
        }
        assert_eq!(
            user_status_condition(Some("unknown")).unwrap_err().1,
            "用户状态筛选无效"
        );
    }
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
    }
    #[tokio::test]
    async fn image_decode_and_corruption() {
        assert!(validate_image(Bytes::from_static(b"not an image"), false)
            .await
            .is_err());
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 3)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        let bytes = Bytes::from(bytes.into_inner());
        let (_, image) = validate_image(bytes.clone(), false).await.unwrap();
        assert_eq!(
            (image.ext, image.mime, image.width, image.height),
            ("png", "image/png", 2, 3)
        );
        assert_eq!(image.hash, storage::hash(&bytes));
        assert!(validate_image(bytes.slice(..40), false).await.is_err());
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
    #[tokio::test]
    async fn conditional_images_match_lists_weak_and_wildcard_without_loading() {
        let etag = "\"img-test\"";
        let mut headers = HeaderMap::new();
        for (value, matches) in [
            ("\"img-test\"", true),
            ("\"other\",  W/\"img-test\" ", true),
            ("*", true),
            ("\"thumb-test\"", false),
            ("img-test", false),
            ("W/*", false),
        ] {
            headers.insert(header::IF_NONE_MATCH, value.parse().unwrap());
            assert_eq!(etag_matches(&headers, etag), matches);
        }
        headers.append(header::IF_NONE_MATCH, "W/\"img-test\"".parse().unwrap());
        let hit = cached_image(&headers, etag.into(), "image/png", async {
            panic!("unexpected file read")
        })
        .await
        .unwrap();
        assert_eq!(hit.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(hit.headers()[header::ETAG], etag);
        assert_eq!(hit.headers()[header::CACHE_CONTROL], "private, no-cache");
        let fresh = cached_image(&HeaderMap::new(), etag.into(), "image/png", async {
            Ok(vec![1])
        })
        .await
        .unwrap();
        assert_eq!(fresh.status(), StatusCode::OK);
        assert_eq!(fresh.headers()[header::ETAG], etag);
        assert_eq!(fresh.headers()[header::CACHE_CONTROL], "private, no-cache");
        assert_eq!(fresh.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    }
    #[tokio::test]
    async fn malformed_upload_bearer_cannot_use_a_session_cookie() {
        let state = test_state();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("piccove_session={}", "a".repeat(64))
                .parse()
                .unwrap(),
        );
        for value in [
            "Bearer pcv_invalid",
            "Basic abc",
            "Bearer invalid",
            "Bearer pcv_",
        ] {
            headers.insert(header::AUTHORIZATION, value.parse().unwrap());
            assert_eq!(
                tokens::bearer(&headers).is_some(),
                value.starts_with("Bearer pcv_")
            );
            let error = tokens::upload_auth(&headers, &state).await.err().unwrap();
            assert_eq!(error.0, StatusCode::UNAUTHORIZED);
        }
    }
    #[tokio::test]
    async fn origin_and_sensitive_response_headers_apply_at_the_http_routes() {
        use axum::{body::Body, handler::Handler, routing::any_service};
        let mut state = test_state();
        state.origin = "https://photos.example".into();
        let api = any_service(router(Arc::new(state)));
        let image = "/api/v1/images/00000000-0000-0000-0000-000000000001/shares";
        for (method, path, expected) in [
            (Method::POST, "/api/v1/me/totp/start", StatusCode::FORBIDDEN),
            (
                Method::POST,
                "/api/v1/me/totp/confirm",
                StatusCode::FORBIDDEN,
            ),
            (
                Method::POST,
                "/api/v1/me/totp/recovery",
                StatusCode::FORBIDDEN,
            ),
            (Method::POST, "/api/v1/me/tokens", StatusCode::FORBIDDEN),
            (Method::POST, image, StatusCode::FORBIDDEN),
            (Method::GET, image, StatusCode::UNAUTHORIZED),
        ] {
            let req = Request::builder()
                .method(method)
                .uri(path)
                .header(header::AUTHORIZATION, "Bearer pcv_invalid")
                .body(Body::empty())
                .unwrap();
            let response = api.clone().call(req, ()).await;
            assert_eq!(response.status(), expected);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        }
        let upload = Request::post("/api/v1/images")
            .header(header::AUTHORIZATION, "Bearer pcv_invalid")
            .header(
                header::COOKIE,
                format!("piccove_session={}", "a".repeat(64)),
            )
            .header(header::CONTENT_TYPE, "multipart/form-data; boundary=test")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            api.call(upload, ()).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
