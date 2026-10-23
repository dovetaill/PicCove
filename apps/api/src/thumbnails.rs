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
    let _permit = state
        .thumbnails
        .clone()
        .acquire_owned()
        .await
        .map_err(internal)?;
    let _guard = state.uploads.lock().await;
    let row: ImageRow = sqlx::query_as("SELECT * FROM images WHERE id=$1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    if !row.is_public {
        let user = authenticate(&headers, &state)
            .await
            .map_err(|_| missing())?;
        if user.id != row.user_id && !user.is_admin {
            return Err(missing());
        }
    }
    let location = storage::image_location(&state, &row).await?;
    let bytes = tokio::task::spawn_blocking(move || {
        let dir = location.open()?;
        let key = key(id);
        match dir.read(&key) {
            Ok((bytes, _)) => return Ok(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(storage::io_error(e)),
        }
        let original = dir.read(&row.storage_key).map_err(storage::io_error)?.0;
        let bytes = render(&original)?;
        if dir.available().map_err(storage::io_error)? > DISK_RESERVE + bytes.len() as u64 {
            dir.copy_verified(&key, &bytes, id)
                .map_err(storage::io_error)?;
        }
        Ok(bytes)
    })
    .await
    .map_err(internal)??;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
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
