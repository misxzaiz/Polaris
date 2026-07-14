use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use std::sync::Arc;

use super::WebError;
use crate::AppState;

/// Get current application configuration.
pub async fn handle_get_settings(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, WebError> {
    let config = state.clone_config_web()?;
    Ok(Json(config))
}

/// Patch application configuration by top-level keys.
pub async fn handle_update_settings(
    State(state): State<Arc<AppState>>,
    Json(patch): Json<serde_json::Value>,
) -> Result<impl IntoResponse, WebError> {
    let mut config_store = state.lock_config()?;
    let config = config_store.patch(patch)?;
    Ok(Json(config))
}
