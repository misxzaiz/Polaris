use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use crate::ai::SessionHistoryProvider;
use crate::commands::chat::{ChatRequestOptions, start_chat_inner};
use crate::web::api::chat::{run_claude_blocking, build_web_callbacks};
use crate::web::error::ok_response;
use crate::web::{validate_session_id, PaginationQuery, parse_pagination};
use crate::AppState;
use super::WebError;

/// Validate that the engine_id is supported. Returns the normalized engine string.
fn validate_engine(engine_id: &str) -> Result<&'static str, WebError> {
    match engine_id {
        "claude" | "claude-code" => Ok("claude-code"),
        _ => Err(WebError::BadRequest(format!("Unsupported engine: {}", engine_id))),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsQuery {
    #[serde(default = "default_engine")]
    pub engine_id: String,
    #[serde(flatten)]
    pub pagination: PaginationQuery,
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
    validate_engine(&query.engine_id)?;
    let pagination = parse_pagination(&query.pagination);
    let work_dir = query.work_dir;
    let result = run_claude_blocking(&state, move |provider| {
        provider.list_sessions(work_dir.as_deref(), pagination)
    }).await?;
    Ok(Json(result))
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
    let (callbacks, app_paths) = build_web_callbacks(&state, &mut options);

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

    validate_engine(&engine_id)?;
    run_claude_blocking(&state, move |provider| {
        provider.delete_session(&session_id)
    }).await?;
    Ok(ok_response())
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
) -> Result<Json<serde_json::Value>, WebError> {
    Err(WebError::NotFound("Session patch not implemented".to_string()))
}
