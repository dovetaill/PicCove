use super::*;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use totp_rs::{Algorithm, Secret, TOTP};
use webauthn_rs::prelude::*;

pub struct Security {
    webauthn: Webauthn,
    challenges: Mutex<HashMap<Uuid, Challenge>>,
}
enum Ceremony {
    Register {
        state: PasskeyRegistration,
        session: String,
        name: String,
    },
    Login(PasskeyAuthentication),
}
struct Challenge {
    user: User,
    expires: Instant,
    ceremony: Ceremony,
}
impl Security {
    pub fn new(origin: &str) -> anyhow::Result<Self> {
        let url = Url::parse(origin)?;
        let rp = url.host_str().context("CORS_ORIGIN requires a hostname")?;
        Ok(Self {
            webauthn: WebauthnBuilder::new(rp, &url)?
                .rp_name("PicCove 图湾")
                .build()?,
            challenges: Mutex::new(HashMap::new()),
        })
    }
    async fn insert(&self, user: User, ceremony: Ceremony) -> ApiResult<Uuid> {
        let mut pending = self.challenges.lock().await;
        pending.retain(|_, item| item.expires > Instant::now());
        if pending.len() >= 512 {
            return Err(bad("请稍后重试"));
        }
        let id = Uuid::new_v4();
        pending.insert(
            id,
            Challenge {
                user,
                ceremony,
                expires: Instant::now() + Duration::from_secs(300),
            },
        );
        Ok(id)
    }
    async fn take(&self, id: Uuid) -> ApiResult<Challenge> {
        self.challenges
            .lock()
            .await
            .remove(&id)
            .filter(|item| item.expires > Instant::now())
            .ok_or_else(|| bad("验证已过期，请重新开始"))
    }
}
pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/v1/me/username", post(rename))
        .route("/api/v1/me/security", get(status))
        .route("/api/v1/me/totp/start", post(totp_start))
        .route("/api/v1/me/totp/confirm", post(totp_confirm))
        .route("/api/v1/me/totp/remove", post(totp_remove))
        .route("/api/v1/me/passkeys/start", post(register_start))
        .route("/api/v1/me/passkeys/finish", post(register_finish))
        .route("/api/v1/me/passkeys/remove", post(passkey_remove))
        .route("/api/v1/auth/passkey/start", post(login_start))
        .route("/api/v1/auth/passkey/finish", post(login_finish))
}
type Tx<'a> = sqlx::Transaction<'a, sqlx::Postgres>;

// Lock the account before validating factors so resets and concurrent changes cannot race them.
pub async fn lock_current(tx: &mut Tx<'_>, user: &User, headers: &HeaderMap) -> ApiResult<()> {
    lock_version(tx, user).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>NOW())")
        .bind(digest(&session_token(headers)?)).bind(user.id).fetch_one(&mut **tx).await.map_err(internal)?;
    if !exists {
        return Err(unauthorized());
    }
    Ok(())
}
async fn lock_version(tx: &mut Tx<'_>, user: &User) -> ApiResult<()> {
    let current: User = sqlx::query_as("SELECT * FROM users WHERE id=$1 FOR UPDATE")
        .bind(user.id)
        .fetch_one(&mut **tx)
        .await
        .map_err(internal)?;
    if current.disabled
        || current.security_version != user.security_version
        || current.password_hash != user.password_hash
    {
        return Err(unauthorized());
    }
    Ok(())
}
fn totp(secret: &str, username: &str) -> ApiResult<TOTP> {
    TOTP::new(
        Algorithm::SHA1,
        6,
        0,
        30,
        Secret::Encoded(secret.into())
            .to_bytes()
            .map_err(internal)?,
        Some("PicCove".into()),
        username.into(),
    )
    .map_err(internal)
}
fn code_step(secret: &str, code: &str, now: i64, last: i64) -> ApiResult<i64> {
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad("请输入六位动态验证码"));
    }
    let generator = totp(secret, "account")?;
    for step in [now / 30, now / 30 - 1, now / 30 + 1] {
        if step > last && step >= 0 && generator.check(code, (step * 30) as u64) {
            return Ok(step);
        }
    }
    Err(bad("验证码无效或已使用，请等待下一组验证码"))
}
pub async fn verify_totp(tx: &mut Tx<'_>, id: Uuid, code: &str) -> ApiResult<()> {
    let (secret, last): (Option<String>, i64) =
        sqlx::query_as("SELECT totp_secret,totp_last_step FROM users WHERE id=$1")
            .bind(id)
            .fetch_one(&mut **tx)
            .await
            .map_err(internal)?;
    if let Some(secret) = secret {
        let step = code_step(&secret, code, Utc::now().timestamp(), last)?;
        sqlx::query("UPDATE users SET totp_last_step=$1 WHERE id=$2")
            .bind(step)
            .bind(id)
            .execute(&mut **tx)
            .await
            .map_err(internal)?;
    }
    Ok(())
}
#[derive(Deserialize)]
struct Proof {
    current_password: String,
    #[serde(default)]
    code: String,
}
async fn reauthenticate(state: &AppState, headers: &HeaderMap, proof: &Proof) -> ApiResult<User> {
    let user = authenticate(headers, state).await?;
    rate(state, format!("security:{}", user.id), 10, 300).await?;
    verify_password(
        proof.current_password.clone(),
        user.password_hash.clone(),
        state,
    )
    .await?;
    Ok(user)
}
async fn changed(tx: &mut Tx<'_>, user: &User, headers: &HeaderMap) -> ApiResult<()> {
    sqlx::query("UPDATE users SET security_version=security_version+1 WHERE id=$1")
        .bind(user.id)
        .execute(&mut **tx)
        .await
        .map_err(internal)?;
    sqlx::query("DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2")
        .bind(user.id)
        .bind(digest(&session_token(headers)?))
        .execute(&mut **tx)
        .await
        .map_err(internal)?;
    Ok(())
}
#[derive(Deserialize)]
struct Rename {
    username: String,
    #[serde(flatten)]
    proof: Proof,
}
async fn rename(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<Rename>,
) -> ApiResult<StatusCode> {
    validate_credentials(&input.username, &input.proof.current_password)?;
    let user = reauthenticate(&state, &headers, &input.proof).await?;
    let mut tx = state.pool.begin().await.map_err(internal)?;
    lock_current(&mut tx, &user, &headers).await?;
    verify_totp(&mut tx, user.id, &input.proof.code).await?;
    sqlx::query("UPDATE users SET username=$1 WHERE id=$2")
        .bind(input.username)
        .bind(user.id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    changed(&mut tx, &user, &headers).await?;
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    let user = authenticate(&headers, &state).await?;
    let enabled: bool = sqlx::query_scalar("SELECT totp_secret IS NOT NULL FROM users WHERE id=$1")
        .bind(user.id)
        .fetch_one(&state.pool)
        .await
        .map_err(internal)?;
    let keys: Vec<(String, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id,name,created_at FROM passkeys WHERE user_id=$1 ORDER BY created_at",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await
    .map_err(internal)?;
    Ok(Json(
        serde_json::json!({"totp_enabled":enabled,"passkeys":keys.into_iter().map(|(id,name,created_at)| serde_json::json!({"id":id,"name":name,"created_at":created_at})).collect::<Vec<_>>()}),
    ))
}
async fn totp_start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(proof): Json<Proof>,
) -> ApiResult<Json<serde_json::Value>> {
    let user = reauthenticate(&state, &headers, &proof).await?;
    let secret = Secret::generate_secret().to_encoded().to_string();
    let generator = totp(&secret, &user.username)?;
    let mut tx = state.pool.begin().await.map_err(internal)?;
    lock_current(&mut tx, &user, &headers).await?;
    let result = sqlx::query("UPDATE users SET totp_pending=$1,totp_pending_until=NOW()+interval '10 minutes' WHERE id=$2 AND totp_secret IS NULL")
        .bind(&secret).bind(user.id).execute(&mut *tx).await.map_err(internal)?;
    if result.rows_affected() == 0 {
        return Err(bad("已开启二步验证"));
    }
    tx.commit().await.map_err(internal)?;
    Ok(Json(
        serde_json::json!({"secret":secret,"uri":generator.get_url()}),
    ))
}
async fn totp_confirm(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(proof): Json<Proof>,
) -> ApiResult<StatusCode> {
    let user = reauthenticate(&state, &headers, &proof).await?;
    let mut tx = state.pool.begin().await.map_err(internal)?;
    lock_current(&mut tx, &user, &headers).await?;
    let secret: Option<String> = sqlx::query_scalar("SELECT totp_pending FROM users WHERE id=$1 AND totp_secret IS NULL AND totp_pending_until>NOW()")
        .bind(user.id).fetch_optional(&mut *tx).await.map_err(internal)?.flatten();
    let secret = secret.ok_or_else(|| bad("绑定已过期，请重新开始"))?;
    let step = code_step(&secret, &proof.code, Utc::now().timestamp(), -1)?;
    sqlx::query("UPDATE users SET totp_secret=$1,totp_last_step=$2,totp_pending=NULL,totp_pending_until=NULL WHERE id=$3")
        .bind(secret).bind(step).bind(user.id).execute(&mut *tx).await.map_err(internal)?;
    changed(&mut tx, &user, &headers).await?;
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn totp_remove(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(proof): Json<Proof>,
) -> ApiResult<StatusCode> {
    let user = reauthenticate(&state, &headers, &proof).await?;
    let mut tx = state.pool.begin().await.map_err(internal)?;
    lock_current(&mut tx, &user, &headers).await?;
    verify_totp(&mut tx, user.id, &proof.code).await?;
    sqlx::query("UPDATE users SET totp_secret=NULL,totp_last_step=-1,totp_pending=NULL,totp_pending_until=NULL WHERE id=$1")
        .bind(user.id).execute(&mut *tx).await.map_err(internal)?;
    changed(&mut tx, &user, &headers).await?;
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn keys(pool: &PgPool, id: Uuid) -> ApiResult<Vec<Passkey>> {
    let rows: Vec<serde_json::Value> =
        sqlx::query_scalar("SELECT credential FROM passkeys WHERE user_id=$1")
            .bind(id)
            .fetch_all(pool)
            .await
            .map_err(internal)?;
    rows.into_iter()
        .map(|v| serde_json::from_value(v).map_err(internal))
        .collect()
}
#[derive(Deserialize)]
struct RegisterStart {
    name: String,
    #[serde(flatten)]
    proof: Proof,
}
async fn register_start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<RegisterStart>,
) -> ApiResult<Json<serde_json::Value>> {
    let name = input.name.trim();
    if name.is_empty() || name.len() > 100 {
        return Err(bad("Passkey 名称须为 1–100 字节"));
    }
    let user = reauthenticate(&state, &headers, &input.proof).await?;
    let registered = keys(&state.pool, user.id).await?;
    if registered.len() >= 10 {
        return Err(bad("最多绑定 10 个 Passkey"));
    }
    let (options, registration) = state
        .security
        .webauthn
        .start_passkey_registration(
            user.id,
            &user.username,
            &user.username,
            Some(registered.iter().map(|k| k.cred_id().clone()).collect()),
        )
        .map_err(internal)?;
    let mut tx = state.pool.begin().await.map_err(internal)?;
    lock_current(&mut tx, &user, &headers).await?;
    verify_totp(&mut tx, user.id, &input.proof.code).await?;
    tx.commit().await.map_err(internal)?;
    let id = state
        .security
        .insert(
            user,
            Ceremony::Register {
                state: registration,
                session: digest(&session_token(&headers)?),
                name: name.into(),
            },
        )
        .await?;
    Ok(Json(serde_json::json!({"id":id,"options":options})))
}
#[derive(Deserialize)]
struct RegisterFinish {
    id: Uuid,
    credential: RegisterPublicKeyCredential,
}
async fn register_finish(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<RegisterFinish>,
) -> ApiResult<StatusCode> {
    let current = authenticate(&headers, &state).await?;
    let challenge = state.security.take(input.id).await?;
    let Ceremony::Register {
        state: registration,
        session,
        name,
    } = challenge.ceremony
    else {
        return Err(bad("验证类型不匹配"));
    };
    if current.id != challenge.user.id || session != digest(&session_token(&headers)?) {
        return Err(forbidden());
    }
    let key = state
        .security
        .webauthn
        .finish_passkey_registration(&input.credential, &registration)
        .map_err(|_| bad("Passkey 验证失败"))?;
    let mut tx = state.pool.begin().await.map_err(internal)?;
    lock_current(&mut tx, &challenge.user, &headers).await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM passkeys WHERE user_id=$1")
        .bind(current.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    if count >= 10 {
        return Err(bad("最多绑定 10 个 Passkey"));
    }
    sqlx::query("INSERT INTO passkeys(id,user_id,name,credential) VALUES($1,$2,$3,$4)")
        .bind(serde_json::to_string(key.cred_id()).map_err(internal)?)
        .bind(current.id)
        .bind(name)
        .bind(serde_json::to_value(key).map_err(internal)?)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            if e.as_database_error()
                .is_some_and(|e| e.is_unique_violation())
            {
                bad("此 Passkey 已绑定")
            } else {
                internal(e)
            }
        })?;
    changed(&mut tx, &current, &headers).await?;
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::CREATED)
}
#[derive(Deserialize)]
struct RemoveKey {
    id: String,
    #[serde(flatten)]
    proof: Proof,
}
async fn passkey_remove(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<RemoveKey>,
) -> ApiResult<StatusCode> {
    let user = reauthenticate(&state, &headers, &input.proof).await?;
    let mut tx = state.pool.begin().await.map_err(internal)?;
    lock_current(&mut tx, &user, &headers).await?;
    verify_totp(&mut tx, user.id, &input.proof.code).await?;
    let result = sqlx::query("DELETE FROM passkeys WHERE id=$1 AND user_id=$2")
        .bind(input.id)
        .bind(user.id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    if result.rows_affected() == 0 {
        return Err(missing());
    }
    changed(&mut tx, &user, &headers).await?;
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
struct LoginStart {
    username: String,
}
async fn login_start(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(input): Json<LoginStart>,
) -> ApiResult<Json<serde_json::Value>> {
    rate(&state, format!("login:{}", peer.ip()), 20, 60).await?;
    rate(&state, "login:global".into(), 120, 60).await?;
    let user: User = sqlx::query_as("SELECT * FROM users WHERE username=$1 AND NOT disabled")
        .bind(input.username)
        .fetch_optional(&state.pool)
        .await
        .map_err(internal)?
        .ok_or_else(|| bad("无法使用 Passkey，请使用密码登录"))?;
    let registered = keys(&state.pool, user.id).await?;
    if registered.is_empty() {
        return Err(bad("无法使用 Passkey，请使用密码登录"));
    }
    let (options, authentication) = state
        .security
        .webauthn
        .start_passkey_authentication(&registered)
        .map_err(internal)?;
    let id = state
        .security
        .insert(user, Ceremony::Login(authentication))
        .await?;
    Ok(Json(serde_json::json!({"id":id,"options":options})))
}
#[derive(Deserialize)]
struct LoginFinish {
    id: Uuid,
    credential: PublicKeyCredential,
}
async fn login_finish(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(input): Json<LoginFinish>,
) -> ApiResult<Response> {
    rate(&state, format!("passkey-finish:{}", peer.ip()), 20, 60).await?;
    let challenge = state.security.take(input.id).await?;
    let Ceremony::Login(authentication) = challenge.ceremony else {
        return Err(bad("验证类型不匹配"));
    };
    let result = state
        .security
        .webauthn
        .finish_passkey_authentication(&input.credential, &authentication)
        .map_err(|_| unauthorized())?;
    let mut tx = state.pool.begin().await.map_err(internal)?;
    lock_version(&mut tx, &challenge.user).await?;
    let id = serde_json::to_string(result.cred_id()).map_err(internal)?;
    let (value, counter): (serde_json::Value, i64) = sqlx::query_as(
        "SELECT credential,signature_counter FROM passkeys WHERE id=$1 AND user_id=$2 FOR UPDATE",
    )
    .bind(&id)
    .bind(challenge.user.id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?
    .ok_or_else(unauthorized)?;
    let mut key: Passkey = serde_json::from_value(value).map_err(internal)?;
    // Verify against the latest counter, including logins completed since this challenge started.
    if (counter > 0 || result.counter() > 0) && i64::from(result.counter()) <= counter {
        return Err(unauthorized());
    }
    key.update_credential(&result).ok_or_else(unauthorized)?;
    sqlx::query("UPDATE passkeys SET credential=$1,signature_counter=$3 WHERE id=$2")
        .bind(serde_json::to_value(key).map_err(internal)?)
        .bind(id)
        .bind(i64::from(result.counter()))
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("DELETE FROM sessions WHERE expires_at<NOW()")
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+interval '7 days')",
    )
    .bind(digest(&token))
    .bind(challenge.user.id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok((
        [(header::SET_COOKIE, cookie(&token, &state, 604800))],
        Json(challenge.user),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn totp_rejects_replay_bad_codes_and_expired_codes() {
        let secret = Secret::Raw(b"12345678901234567890".to_vec())
            .to_encoded()
            .to_string();
        let generator = totp(&secret, "admin").unwrap();
        let now = 1_700_000_000;
        let code = generator.generate(now as u64);
        let step = code_step(&secret, &code, now, -1).unwrap();
        assert!(code_step(&secret, &code, now, step).is_err());
        assert!(code_step(&secret, "", now, -1).is_err());
        assert!(code_step(&secret, "abcdef", now, -1).is_err());
        assert!(code_step(&secret, &code, now + 90, -1).is_err());
        assert!(code_step(&secret, &generator.generate((now - 30) as u64), now, -1).is_ok());
    }
    #[test]
    fn rp_uses_configured_origin() {
        assert!(Security::new("https://photos.example.com").is_ok());
        assert!(Security::new("http://localhost:5173").is_ok());
        assert!(Security::new("not a url").is_err());
    }
}
