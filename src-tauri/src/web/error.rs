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

    #[error("Internal error: {0}")]
    Internal(String),
}

impl IntoResponse for WebError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            WebError::Unauthorized => (StatusCode::UNAUTHORIZED, self.to_string()),
            WebError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            WebError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            WebError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.clone()),
        };

        let body = json!({ "error": message });
        (status, axum::Json(body)).into_response()
    }
}

impl From<crate::error::AppError> for WebError {
    fn from(err: crate::error::AppError) -> Self {
        WebError::Internal(err.to_string())
    }
}
