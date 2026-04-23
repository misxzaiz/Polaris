use axum::response::IntoResponse;

use super::super::error::WebError;

pub async fn handle_verify_token() -> Result<impl IntoResponse, WebError> {
    // If auth middleware passed, token is valid
    Ok(axum::Json(serde_json::json!({ "valid": true })))
}

#[derive(Debug, serde::Deserialize)]
pub struct TokenRequest {
    pub token: Option<String>,
}

pub async fn handle_token_exchange(
    axum::Json(_req): axum::Json<TokenRequest>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: validate provided token and return current token info
    Ok(axum::Json(serde_json::json!({ "valid": false })))
}
