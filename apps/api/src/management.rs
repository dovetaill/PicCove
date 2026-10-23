use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub async fn storage(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    administrator(&headers, &state).await?;
    let path: Option<String> = sqlx::query_scalar("SELECT upload_dir FROM settings")
        .fetch_one(&state.pool)
        .await
        .map_err(internal)?;
    Ok(Json(
        serde_json::json!({"upload_dir": path.unwrap_or_else(|| state.upload_dir.to_string_lossy().into_owned())}),
    ))
}

#[derive(Deserialize)]
pub struct StorageInput {
    upload_dir: String,
}

pub async fn set_storage(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<StorageInput>,
) -> ApiResult<StatusCode> {
    administrator(&headers, &state).await?;
    let _guard = state.uploads.lock().await;
    let location = storage::location(&state, input.upload_dir.trim()).await?;
    location.open()?.probe().map_err(storage::io_error)?;
    let path = PathBuf::from(location.path);
    sqlx::query("UPDATE settings SET upload_dir=$1")
        .bind(path.to_string_lossy().as_ref())
        .execute(&state.pool)
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn control(action: &str) -> ApiResult<serde_json::Value> {
    let path =
        env::var("PICCOVE_CONTROL_SOCKET").unwrap_or_else(|_| "/run/piccove/control.sock".into());
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut socket = tokio::net::UnixStream::connect(path).await?;
        socket.write_all(format!("{action}\n").as_bytes()).await?;
        let mut bytes = Vec::new();
        socket.take(65537).read_to_end(&mut bytes).await?;
        if bytes.len() > 65536 {
            return Err(std::io::Error::other("response too large"));
        }
        serde_json::from_slice(&bytes).map_err(std::io::Error::other)
    })
    .await;
    result
        .map_err(|_| bad("宿主机管理服务响应超时"))?
        .map_err(|_| bad("宿主机管理服务未连接，请先按运维文档启用 piccovectl web-manager"))
}

pub async fn system(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    administrator(&headers, &state).await?;
    let manager = control("status").await;
    Ok(Json(
        serde_json::json!({"version":env!("CARGO_PKG_VERSION"), "manager":manager.as_ref().ok(), "manager_error":manager.err().map(|e| e.1)}),
    ))
}

pub async fn check(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    administrator(&headers, &state).await?;
    rate(&state, "release-check".into(), 10, 60).await?;
    let response = reqwest::Client::builder()
        .https_only(true)
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("PicCove")
        .build()
        .map_err(internal)?
        .get("https://api.github.com/repos/dovetaill/PicCove/releases/latest")
        .send()
        .await
        .map_err(|_| bad("无法连接 GitHub，请稍后重试"))?
        .error_for_status()
        .map_err(|_| bad("无法获取最新稳定版本，可能尚未发布或 GitHub 限流"))?;
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(internal)? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(bad("版本信息过大"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let data: serde_json::Value = serde_json::from_slice(&bytes).map_err(internal)?;
    let tag = data["tag_name"]
        .as_str()
        .ok_or_else(|| bad("版本信息无效"))?;
    let latest = parse_version(tag).ok_or_else(|| bad("版本格式无效"))?;
    if data["draft"] != false || data["prerelease"] != false {
        return Err(bad("不是稳定版本"));
    }
    Ok(Json(
        serde_json::json!({"latest":tag,"update_available":latest > parse_version(env!("CARGO_PKG_VERSION")).expect("package version"),"url":format!("https://github.com/dovetaill/PicCove/releases/tag/{tag}")}),
    ))
}

fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
    let parts: Vec<_> = value
        .strip_prefix('v')
        .unwrap_or(value)
        .split('.')
        .collect();
    if parts.len() != 3
        || parts.iter().any(|p| {
            p.is_empty()
                || !p.bytes().all(|b| b.is_ascii_digit())
                || (p.len() > 1 && p.starts_with('0'))
        })
    {
        return None;
    }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ))
}

pub async fn action(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(action): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    administrator(&headers, &state).await?;
    if !["update", "restart"].contains(&action.as_str()) {
        return Err(missing());
    }
    let result = control(&action).await?;
    if let Some(error) = result["error"].as_str() {
        return Err(bad(error));
    }
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_versions_only() {
        assert!(parse_version("v0.10.0") > parse_version("0.9.9"));
        for value in ["1.0", "1.0.0-rc1", "01.0.0", "1.0.0/evil", "v1.0.0\n"] {
            assert!(parse_version(value).is_none());
        }
    }
}
