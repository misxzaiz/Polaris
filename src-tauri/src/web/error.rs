use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum WebError {
    #[error("Unauthorized")]
    Unauthorized,

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Forbidden: {0}")]
    Forbidden(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

/// Convenience helper for the common `{ "status": "ok" }` JSON response.
pub fn ok_response() -> axum::Json<serde_json::Value> {
    axum::Json(json!({ "status": "ok" }))
}

impl IntoResponse for WebError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            WebError::Unauthorized => (StatusCode::UNAUTHORIZED, "Unauthorized".to_owned()),
            WebError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            WebError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            WebError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg),
            WebError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };

        let body = json!({ "error": message });
        (status, axum::Json(body)).into_response()
    }
}

impl From<crate::error::AppError> for WebError {
    fn from(err: crate::error::AppError) -> Self {
        match &err {
            crate::error::AppError::ValidationError(_) => WebError::BadRequest(err.to_string()),
            crate::error::AppError::SessionNotFound(id) => WebError::NotFound(format!("Session not found: {}", id)),
            crate::error::AppError::PermissionDenied(msg) => WebError::Forbidden(format!("Permission denied: {}", msg)),
            crate::error::AppError::InvalidPath(path) => WebError::BadRequest(format!("Invalid path: {}", path)),
            _ => WebError::Internal(err.to_string()),
        }
    }
}
