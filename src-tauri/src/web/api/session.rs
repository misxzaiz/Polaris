use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use crate::ai::{CodexHistoryProvider, SessionHistoryProvider};
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
        "codex" | "openai-codex" => Ok("codex"),
        "simple-ai" | "simpleai" => Ok("simple-ai"),
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
    #[serde(alias = "projectPath")]
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
    let engine = validate_engine(&query.engine_id)?;
    let pagination = parse_pagination(&query.pagination);

    let work_dir = query.work_dir;
    let config = state.clone_config().map_err(WebError::Internal)?;
    let result = match engine {
        "claude-code" => run_claude_blocking(&state, move |provider| {
            provider.list_sessions(work_dir.as_deref(), pagination)
        }).await?,
        "codex" => {
            tokio::task::spawn_blocking(move || {
                let provider = CodexHistoryProvider::new(config);
                provider.list_sessions(work_dir.as_deref(), pagination)
            })
            .await
            .map_err(|e| WebError::Internal(e.to_string()))??
        }
        _ => unreachable!(),
    };
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
/// Returns the session ID as a plain string on success (matches Tauri command behavior).
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
    Ok(Json(sid))
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
    let engine = validate_engine(&engine_id)?;

    let config = state.clone_config().map_err(WebError::Internal)?;
    match engine {
        "claude-code" => {
            run_claude_blocking(&state, move |provider| {
                provider.delete_session(&session_id)
            }).await?;
        }
        "codex" => {
            tokio::task::spawn_blocking(move || {
                let provider = CodexHistoryProvider::new(config);
                provider.delete_session(&session_id)
            })
            .await
            .map_err(|e| WebError::Internal(e.to_string()))??;
        }
        _ => unreachable!(),
    }
    Ok(ok_response())
}

// ============================================================================
// Legacy handlers — return flat arrays matching Tauri command output format.
//
// The newer `handle_list_sessions` / `handle_get_history` return `PagedResult<T>`,
// but the legacy frontend commands (`list_claude_code_sessions`,
// `get_claude_code_session_history`) expect plain arrays (matching Tauri `Vec<T>`
// return type). These dedicated handlers bridge the gap.
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyListSessionsQuery {
    #[serde(alias = "projectPath")]
    pub work_dir: Option<String>,
}

/// List Claude Code sessions as a flat array (legacy format).
///
/// Matches the Tauri `list_claude_code_sessions` command output: `Vec<SessionMeta>`.
/// Returns all sessions without pagination, sorted by most recently modified.
pub async fn handle_list_claude_sessions(
    State(state): State<Arc<AppState>>,
    Query(query): Query<LegacyListSessionsQuery>,
) -> Result<impl IntoResponse, WebError> {
    let work_dir = query.work_dir;
    let result = run_claude_blocking(&state, move |provider| {
        // Use a large page size to effectively return all sessions
        let pagination = crate::ai::history::Pagination { page: 1, page_size: 10_000 };
        provider.list_sessions(work_dir.as_deref(), pagination)
    }).await?;
    // Return only the items array, not the PagedResult wrapper
    Ok(Json(result.items))
}

/// Get session history messages as a flat array (legacy format).
///
/// Matches the Tauri `get_claude_code_session_history` command output: `Vec<HistoryMessage>`.
/// Returns all messages without pagination.
pub async fn handle_get_claude_session_history(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, WebError> {
    validate_session_id(&session_id)?;

    let result = run_claude_blocking(&state, move |provider| {
        // Use a large page size to effectively return all messages
        let pagination = crate::ai::history::Pagination { page: 1, page_size: 100_000 };
        provider.get_session_history(&session_id, pagination)
    }).await?;
    // Return only the items array, not the PagedResult wrapper
    Ok(Json(result.items))
}
