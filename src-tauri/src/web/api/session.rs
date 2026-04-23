use axum::extract::State;
use axum::response::IntoResponse;
use std::sync::Arc;

use crate::AppState;
use super::super::error::WebError;

pub async fn handle_list_sessions(
    State(_state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: implement
    Ok(axum::Json(serde_json::json!([])))
}
