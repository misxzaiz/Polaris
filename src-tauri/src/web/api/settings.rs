use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use std::sync::Arc;

use crate::models::config::Config;
use crate::AppState;
use super::WebError;
use crate::web::error::ok_response;

/// Get current application configuration.
pub async fn handle_get_settings(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, WebError> {
    let config_store = state.lock_config()?;
    let config = config_store.get().clone();
    Ok(Json(config))
}

/// Update application configuration (full replace).
pub async fn handle_update_settings(
    State(state): State<Arc<AppState>>,
    Json(new_config): Json<Config>,
) -> Result<impl IntoResponse, WebError> {
    let mut config_store = state.lock_config()?;
    config_store.update(new_config)?;
    Ok(ok_response())
}
