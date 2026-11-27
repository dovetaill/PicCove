use super::*;

const PREFIX: &str = "pcv_";

#[derive(Serialize, FromRow)]
pub(super) struct Token {
    id: Uuid,
    name: String,
    default_album_id: Option<Uuid>,
    default_public: bool,
    last_used_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

pub(super) async fn for_user(pool: &PgPool, user: Uuid) -> ApiResult<Vec<Token>> {
    sqlx::query_as("SELECT * FROM api_tokens WHERE user_id=$1 ORDER BY created_at DESC")
        .bind(user)
        .fetch_all(pool)
        .await
        .map_err(internal)
}

pub(super) async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<Token>>> {
    let user = authenticate(&headers, &state).await?;
    Ok(Json(for_user(&state.pool, user.id).await?))
}

#[derive(Deserialize)]
pub(super) struct NewToken {
    name: String,
    default_album_id: Option<Uuid>,
    default_public: Option<bool>,
}

pub(super) async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<NewToken>,
) -> ApiResult<(StatusCode, Json<serde_json::Value>)> {
    let user = authenticate(&headers, &state).await?;
    let name = input.name.trim();
    if !(1..=80).contains(&name.chars().count()) {
        return Err(bad("令牌名称须为 1–80 字符"));
    }
    let mut tx = state.pool.begin().await.map_err(internal)?;
    security::lock_current(&mut tx, &user, &headers).await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM api_tokens WHERE user_id=$1")
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    if count >= 10 {
        return Err(bad("每个账号最多创建 10 个上传令牌"));
    }
    check_album(&mut tx, user.id, input.default_album_id).await?;
    let token = format!("{PREFIX}{}", random_hex::<32>()?);
    let row: Token = sqlx::query_as(
        "INSERT INTO api_tokens (id,user_id,name,token_hash,default_album_id,default_public)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(user.id)
    .bind(name)
    .bind(digest(&token))
    .bind(input.default_album_id)
    .bind(input.default_public.unwrap_or(true))
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    let mut result = serde_json::to_value(row).map_err(internal)?;
    result["token"] = token.into();
    Ok((StatusCode::CREATED, Json(result)))
}

pub(super) async fn remove(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let user = authenticate(&headers, &state).await?;
    let result = sqlx::query("DELETE FROM api_tokens WHERE id=$1 AND user_id=$2")
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

pub(super) fn bearer(headers: &HeaderMap) -> Option<&str> {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let token = values.next()?.to_str().ok()?.strip_prefix("Bearer ")?;
    (values.next().is_none() && token.starts_with(PREFIX)).then_some(token)
}

pub(super) async fn upload_auth(
    headers: &HeaderMap,
    state: &AppState,
) -> ApiResult<(User, Option<Uuid>, bool)> {
    if !headers.contains_key(header::AUTHORIZATION) {
        return Ok((authenticate(headers, state).await?, None, true));
    }
    let token = bearer(headers)
        .filter(|token| lower_hex(&token[PREFIX.len()..], 64))
        .ok_or_else(unauthorized)?;
    let row = sqlx::query(
        "UPDATE api_tokens t SET last_used_at=NOW() FROM users u
        WHERE t.token_hash=$1 AND t.user_id=u.id AND NOT u.disabled
        RETURNING u.*, t.default_album_id, t.default_public",
    )
    .bind(digest(token))
    .fetch_optional(&state.pool)
    .await
    .map_err(internal)?
    .ok_or_else(unauthorized)?;
    Ok((
        User::from_row(&row).map_err(internal)?,
        row.try_get("default_album_id").map_err(internal)?,
        row.try_get("default_public").map_err(internal)?,
    ))
}
