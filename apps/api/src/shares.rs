use super::*;
use serde_json::{json, Value};

#[derive(FromRow)]
struct Share {
    id: Uuid,
    token: String,
    expires_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
}
impl Share {
    fn dto(self, state: &AppState) -> Value {
        json!({"id":self.id,"expires_at":self.expires_at,"created_at":self.created_at,
            "url":format!("{}/s/{}",state.public_base_url.trim_end_matches('/'), self.token)})
    }
}

fn allow_link(row: &ImageRow) -> ApiResult<()> {
    if ai::access(
        &row.moderation_status,
        row.moderation_hold,
        true,
        false,
        false,
    ) {
        Ok(())
    } else {
        Err(missing())
    }
}

#[derive(Deserialize)]
pub(super) struct Lifetime {
    ttl_hours: i64,
}

pub(super) async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<Lifetime>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let user = authenticate(&headers, &state).await?;
    ai::can_create(&user)?;
    if !(1..=720).contains(&input.ttl_hours) {
        return Err(bad("分享有效期须为 1–720 小时"));
    }
    let mut tx = state.pool.begin().await.map_err(internal)?;
    let row: ImageRow = sqlx::query_as(
        "SELECT * FROM images WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?
    .ok_or_else(missing)?;
    allow_link(&row)?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM image_shares WHERE image_id=$1 AND revoked_at IS NULL AND expires_at>NOW()")
        .bind(id).fetch_one(&mut *tx).await.map_err(internal)?;
    if count >= 20 {
        return Err(bad("每张图片最多保留 20 个有效分享"));
    }
    let share: Share = sqlx::query_as(
        "INSERT INTO image_shares(id,image_id,user_id,token,expires_at)
        VALUES ($1,$2,$3,$4,NOW()+make_interval(hours => $5)) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(id)
    .bind(user.id)
    .bind(random_hex::<16>()?)
    .bind(input.ttl_hours as i32)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok((StatusCode::CREATED, Json(share.dto(&state))))
}

pub(super) async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<Value>>> {
    let user = authenticate(&headers, &state).await?;
    sqlx::query("SELECT id FROM images WHERE id=$1 AND (user_id=$2 OR $3)")
        .bind(id)
        .bind(user.id)
        .bind(user.is_admin)
        .fetch_optional(&state.pool)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    let shares: Vec<Share> = sqlx::query_as("SELECT * FROM image_shares WHERE image_id=$1 AND revoked_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC")
        .bind(id).fetch_all(&state.pool).await.map_err(internal)?;
    Ok(Json(
        shares.into_iter().map(|share| share.dto(&state)).collect(),
    ))
}

pub(super) async fn revoke(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((image, share)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    let user = authenticate(&headers, &state).await?;
    let result = sqlx::query("UPDATE image_shares s SET revoked_at=NOW() FROM images i
        WHERE s.id=$1 AND s.image_id=$2 AND i.id=s.image_id AND (i.user_id=$3 OR $4) AND s.revoked_at IS NULL")
        .bind(share).bind(image).bind(user.id).bind(user.is_admin).execute(&state.pool).await.map_err(internal)?;
    if result.rows_affected() == 0 {
        return Err(missing());
    }
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn serve(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> ApiResult<Response> {
    if !lower_hex(&token, 32) {
        return Err(missing());
    }
    let row: ImageRow = sqlx::query_as("SELECT i.* FROM image_shares s JOIN images i ON i.id=s.image_id
        JOIN users u ON u.id=i.user_id WHERE s.token=$1 AND s.revoked_at IS NULL AND s.expires_at>NOW()
        AND i.deleted_at IS NULL AND NOT u.disabled")
        .bind(token).fetch_optional(&state.pool).await.map_err(internal)?.ok_or_else(missing)?;
    allow_link(&row)?;
    let bytes = storage::read_image(&state, &row).await?;
    Ok((
        [
            (header::CONTENT_TYPE, row.content_type.as_str()),
            (header::CACHE_CONTROL, "private, no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::HeaderName::from_static("x-robots-tag"), "noindex"),
        ],
        bytes,
    )
        .into_response())
}
