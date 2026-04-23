use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use std::sync::Arc;

use crate::AppState;
use super::super::error::WebError;

pub async fn handle_get_settings(
    State(_state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: route to get_config
    Ok(Json(serde_json::json!({})))
}

pub async fn handle_update_settings(
    State(_state): State<Arc<AppState>>,
    Json(_req): Json<serde_json::Value>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: route to update_config
    Ok(Json(serde_json::json!({ "status": "ok" })))
}
