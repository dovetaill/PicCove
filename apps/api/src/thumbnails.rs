use super::*;
pub fn key(id: Uuid) -> String {
    format!(".thumbnails/{id}.png")
}
fn render(bytes: &[u8]) -> ApiResult<Vec<u8>> {
    let format = image::guess_format(bytes).map_err(|_| bad("无效图片"))?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16000);
    limits.max_image_height = Some(16000);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|_| bad("图片解码失败"))?;
    let mut output = Cursor::new(Vec::new());
    image
        .thumbnail(480, 480)
        .write_to(&mut output, ImageFormat::Png)
        .map_err(internal)?;
    Ok(output.into_inner())
}
pub async fn serve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Response> {
    let row: ImageRow = sqlx::query_as("SELECT * FROM images WHERE id=$1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    ai::authorize_image(&state, &headers, &row).await?;
    cached_image(
        &headers,
        format!("\"thumb-{id}\""),
        "image/png",
        load(&state, row),
    )
    .await
}
async fn load(state: &AppState, row: ImageRow) -> ApiResult<Vec<u8>> {
    let _permit = state.thumbnails.acquire().await.map_err(internal)?;
    let id = row.id;
    let location = storage::image_location(state, &row).await?;
    let (bytes, cache) = tokio::task::spawn_blocking(move || {
        let dir = location.open()?;
        let key = key(id);
        match dir.read(&key) {
            Ok((bytes, _)) => return Ok((bytes, None)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(storage::io_error(e)),
        }
        let original = dir.read_original(&row.storage_key)?;
        let bytes = render(&original)?;
        let space = dir.available().map_err(storage::io_error)? > DISK_RESERVE + bytes.len() as u64;
        Ok((bytes, space.then_some(dir)))
    })
    .await
    .map_err(internal)??;
    if let Some(dir) = cache {
        let _write = state.storage_write.lock().await;
        let live: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM images WHERE id=$1 AND deleted_at IS NULL AND storage_root IS NOT DISTINCT FROM $2)",
        )
        .bind(id)
        .bind(&row.storage_root)
        .fetch_one(&state.pool)
        .await
        .map_err(internal)?;
        if live {
            let cached = bytes.clone();
            let _ = tokio::task::spawn_blocking(move || {
                match dir.copy_verified(&key(id), &cached, id) {
                    Ok(()) => (),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
                    Err(e) => {
                        tracing::warn!(image_id = %id, error = %e, "thumbnail cache write skipped")
                    }
                }
            })
            .await;
        }
    }
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_preview_preserves_original() {
        let mut original = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1000, 600)
            .write_to(&mut original, ImageFormat::Png)
            .unwrap();
        let before = original.get_ref().clone();
        let preview = render(&before).unwrap();
        let decoded = image::load_from_memory(&preview).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (480, 288));
        assert_eq!(original.into_inner(), before);
        assert!(render(b"invalid").is_err());
    }
}
