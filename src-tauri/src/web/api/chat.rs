use axum::extract::State;
use axum::response::IntoResponse;
use std::sync::Arc;

use crate::AppState;
use super::super::error::WebError;

pub async fn handle_send_message(
    State(_state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: implement — route to start_chat_inner or continue_chat_inner
    Ok(axum::Json(serde_json::json!({ "status": "ok" })))
}
