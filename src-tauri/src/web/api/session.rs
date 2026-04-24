use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use crate::ai::{ClaudeHistoryProvider, SessionHistoryProvider, Pagination};
use crate::commands::chat::{ChatCallbacks, ChatRequestOptions, start_chat_inner};
use crate::web::api::chat::{create_emit_callback, resolve_app_paths};
use crate::AppState;
use super::super::error::WebError;
use super::chat::validate_session_id;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsQuery {
    #[serde(default = "default_engine")]
    pub engine_id: String,
    pub page: Option<usize>,
    pub page_size: Option<usize>,
    pub work_dir: Option<String>,
}

fn default_engine() -> String {
    "claude-code".to_string()
}

/// List all sessions with optional pagination and engine filter.
/// Uses spawn_blocking to offload filesystem I/O from the async runtime.
pub async fn handle_list_sessions(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListSessionsQuery>,
) -> Result<impl IntoResponse, WebError> {
    let pagination = Pagination::new(query.page.unwrap_or(1), query.page_size.unwrap_or(50));

    match query.engine_id.as_str() {
        "claude" | "claude-code" => {
            let blocking_task = {
                let config = state.clone_config()
                    .map_err(WebError::Internal)?;

                let work_dir = query.work_dir;
                tokio::task::spawn_blocking(move || {
                    let provider = ClaudeHistoryProvider::new(config);
                    provider.list_sessions(work_dir.as_deref(), pagination)
                })
            };
            let result = blocking_task.await
                .map_err(|e| WebError::Internal(e.to_string()))?
                .map_err(WebError::from)?;
            Ok(Json(result))
        }
        _ => Err(WebError::BadRequest(format!("Unsupported engine: {}", query.engine_id))),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    /// Initial message to start the session with. If empty, returns guidance.
    pub message: Option<String>,
    #[serde(default)]
    pub options: Option<ChatRequestOptions>,
}

/// Create a new chat session by sending an initial message.
/// Returns `{ "sessionId": "<uuid>" }` on success.
/// If no message is provided, returns 400 with guidance to use this endpoint.
pub async fn handle_create_session(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateSessionRequest>,
) -> Result<impl IntoResponse, WebError> {
    let message = req.message
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| WebError::BadRequest(
            "Provide a message to start a new session, or use POST /api/chat/send".to_string()
        ))?
        .to_string();

    let mut options = req.options.unwrap_or_default();
    if options.context_id.is_none() {
        options.context_id = Some("web".to_string());
    }

    let emit_event = create_emit_callback(state.clone());
    let notify_complete = Arc::new(|| {});
    let callbacks = ChatCallbacks { emit_event, notify_complete };

    let app_paths = resolve_app_paths(&state);

    let sid = start_chat_inner(message, options, &state, callbacks, &app_paths).await?;
    Ok(Json(serde_json::json!({ "sessionId": sid })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionQuery {
    pub engine_id: Option<String>,
}

/// Delete a session by ID.
/// Uses spawn_blocking to offload filesystem I/O from the async runtime.
pub async fn handle_delete_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<DeleteSessionQuery>,
) -> Result<impl IntoResponse, WebError> {
    validate_session_id(&session_id)?;

    let engine_id = query.engine_id.unwrap_or_else(default_engine);

    match engine_id.as_str() {
        "claude" | "claude-code" => {
            let blocking_task = {
                let config = state.clone_config()
                    .map_err(WebError::Internal)?;

                tokio::task::spawn_blocking(move || {
                    let provider = ClaudeHistoryProvider::new(config);
                    provider.delete_session(&session_id)
                })
            };
            blocking_task.await
                .map_err(|e| WebError::Internal(e.to_string()))?
                .map_err(WebError::from)?;
            Ok(Json(serde_json::json!({ "status": "ok" })))
        }
        _ => Err(WebError::BadRequest(format!("Unsupported engine: {}", engine_id))),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSessionRequest {
    pub name: Option<String>,
    pub active: Option<bool>,
}

/// Session metadata update (rename/activate).
/// Returns 404 because `SessionHistoryProvider` has no update method and
/// `SessionMeta` lacks mutable `name`/`active` fields — JSONL storage is append-only.
pub async fn handle_patch_session(
    State(_state): State<Arc<AppState>>,
    Path(_session_id): Path<String>,
    Json(_req): Json<PatchSessionRequest>,
) -> Result<axum::Json<serde_json::Value>, WebError> {
    Err(WebError::NotFound("Session patch not implemented".to_string()))
}
