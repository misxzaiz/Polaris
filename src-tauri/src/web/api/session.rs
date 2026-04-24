use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::ai::{ClaudeHistoryProvider, SessionHistoryProvider, Pagination};
use crate::AppState;
use super::super::error::WebError;

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
                let config_store = state.config_store.lock()
                    .map_err(|e| WebError::Internal(e.to_string()))?;
                let config = config_store.get().clone();
                drop(config_store);

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
        _ => Err(WebError::BadRequest(format!("不支持的引擎: {}", query.engine_id))),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub session_id: String,
}

/// Sessions are created implicitly via POST /api/chat/send — this endpoint returns guidance.
pub async fn handle_create_session(
    State(_state): State<Arc<AppState>>,
    Json(_req): Json<CreateSessionRequest>,
) -> Result<impl IntoResponse, WebError> {
    Err::<Json<serde_json::Value>, WebError>(WebError::BadRequest("会话通过发送消息自动创建，无需手动创建".to_string()))
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
    let engine_id = query.engine_id.unwrap_or_else(default_engine);

    match engine_id.as_str() {
        "claude" | "claude-code" => {
            let blocking_task = {
                let config_store = state.config_store.lock()
                    .map_err(|e| WebError::Internal(e.to_string()))?;
                let config = config_store.get().clone();
                drop(config_store);

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
        _ => Err(WebError::BadRequest(format!("不支持的引擎: {}", engine_id))),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSessionRequest {
    pub name: Option<String>,
    pub active: Option<bool>,
}

/// Session rename/switch — placeholder for future extension.
pub async fn handle_patch_session(
    State(_state): State<Arc<AppState>>,
    Path(_session_id): Path<String>,
    Json(_req): Json<PatchSessionRequest>,
) -> Result<impl IntoResponse, WebError> {
    Ok(Json(serde_json::json!({ "status": "ok" })))
}
