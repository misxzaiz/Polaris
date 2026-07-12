use axum::body::Body;
use axum::extract::Path;
use axum::http::{header, Response, StatusCode};

use super::WebError;

const CODEX_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];

fn is_safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !value.contains("..")
}

fn codex_generated_image_path(
    thread_id: &str,
    file_name: &str,
) -> Result<std::path::PathBuf, WebError> {
    if !is_safe_segment(thread_id) || !is_safe_segment(file_name) {
        return Err(WebError::BadRequest("Invalid artifact path".to_string()));
    }

    let ext = std::path::Path::new(file_name)
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| v.to_ascii_lowercase())
        .ok_or_else(|| WebError::BadRequest("Missing artifact extension".to_string()))?;

    if !CODEX_IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(WebError::BadRequest(
            "Unsupported artifact type".to_string(),
        ));
    }

    let home = dirs::home_dir()
        .ok_or_else(|| WebError::Internal("Unable to resolve home directory".to_string()))?;

    Ok(home
        .join(".codex")
        .join("generated_images")
        .join(thread_id)
        .join(file_name))
}

fn content_type_for(file_name: &str) -> &'static str {
    match std::path::Path::new(file_name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

pub async fn handle_codex_image_artifact(
    Path((thread_id, file_name)): Path<(String, String)>,
) -> Result<Response<Body>, WebError> {
    let path = codex_generated_image_path(&thread_id, &file_name)?;

    let bytes = tokio::fs::read(&path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WebError::NotFound("Artifact not found".to_string())
        } else {
            WebError::Internal(format!("Failed to read artifact: {}", e))
        }
    })?;

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type_for(&file_name))
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .body(Body::from(bytes))
        .map_err(|e| WebError::Internal(format!("Failed to build artifact response: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_segments() {
        assert!(!is_safe_segment("../secret.png"));
        assert!(!is_safe_segment("a/b.png"));
        assert!(!is_safe_segment(""));
        assert!(is_safe_segment("019ddbda-c6e1-7d33-83cf-15140b579b4e"));
        assert!(is_safe_segment("ig_abc123.png"));
    }

    #[test]
    fn maps_content_types() {
        assert_eq!(content_type_for("x.png"), "image/png");
        assert_eq!(content_type_for("x.jpeg"), "image/jpeg");
        assert_eq!(content_type_for("x.webp"), "image/webp");
    }
}
