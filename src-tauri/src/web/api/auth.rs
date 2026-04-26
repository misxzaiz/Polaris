use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use std::sync::Arc;

use crate::AppState;

/// Verify endpoint — always returns valid (token auth removed).
pub async fn handle_verify_token(
    _state: State<Arc<AppState>>,
) -> Result<impl IntoResponse, super::WebError> {
    Ok(Json(serde_json::json!({ "valid": true })))
}
