use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use std::sync::Arc;

use crate::models::config::Config;
use crate::AppState;
use super::super::error::WebError;

/// Get current application configuration.
pub async fn handle_get_settings(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, WebError> {
    let config_store = state.config_store.lock()
        .map_err(|e| WebError::Internal(e.to_string()))?;
    let config = config_store.get().clone();
    Ok(Json(config))
}

/// Update application configuration (full replace).
pub async fn handle_update_settings(
    State(state): State<Arc<AppState>>,
    Json(new_config): Json<Config>,
) -> Result<impl IntoResponse, WebError> {
    let mut config_store = state.config_store.lock()
        .map_err(|e| WebError::Internal(e.to_string()))?;
    config_store.update(new_config)?;
    Ok(Json(serde_json::json!({ "status": "ok" })))
}
