use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;
#[cfg(feature = "tauri-app")]
use tauri::Emitter;

use crate::commands::chat::{ChatCallbacks, ChatRequestOptions, AppPaths, start_chat_inner, continue_chat_inner, interrupt_chat_inner};
use crate::ai::SessionHistoryProvider;
use crate::state::QuestionAnswer;
use crate::web::error::ok_response;
use crate::web::{validate_session_id, validate_entity_id, PaginationQuery, parse_pagination};
use crate::AppState;
use super::WebError;

/// Resolve AppPaths (config_dir + resource_dir) from AppState.
///
/// 优先取 `data_root.config_dir()`，与启动期解析保持一致。
pub fn resolve_app_paths(state: &AppState) -> AppPaths {
    let config_dir = state.data_root.config_dir();
    let resource_dir = state.resource_dir.get().and_then(|p| p.clone());
    AppPaths { config_dir, resource_dir }
}

/// Dual-emit: broadcast event to both WebSocket clients and Tauri webview.
///
/// For WebSocket: wraps in `{"event":"chat-event","payload":...}` envelope
/// so the frontend WS handler can route by event name.
/// For Tauri webview: emits raw event via `app_handle.emit("chat-event", ...)`.
pub fn dual_emit(state: &AppState, event: &serde_json::Value) {
    // WebSocket broadcast — wrap in envelope for event routing
    let ws_msg = serde_json::json!({
        "event": "chat-event",
        "payload": event,
    });
    if let Err(e) = state.event_broadcast.send(ws_msg.to_string()) {
        tracing::warn!("WebSocket broadcast send failed (no active receivers): {}", e);
    }
    #[cfg(feature = "tauri-app")]
    if let Some(handle) = state.app_handle.get() {
        if let Err(e) = handle.emit("chat-event", event) {
            tracing::warn!("Tauri webview emit failed: {}", e);
        }
    }
}

/// Create a shared emit callback that captures an `Arc<AppState>` for use in
/// `ChatCallbacks`. This avoids duplicating the dual-emit logic at every call site.
pub fn create_emit_callback(state: Arc<AppState>) -> Arc<dyn Fn(serde_json::Value) + Send + Sync> {
    Arc::new(move |json: serde_json::Value| {
        dual_emit(&state, &json);
    })
}

/// Build ChatCallbacks and AppPaths for a web-initiated chat operation.
/// Sets context_id to "web" if not already specified.
pub fn build_web_callbacks(state: &Arc<AppState>, options: &mut ChatRequestOptions) -> (ChatCallbacks, AppPaths) {
    if options.context_id.is_none() {
        options.context_id = Some("web".to_string());
    }
    let emit_event = create_emit_callback(state.clone());
    let notify_complete = Arc::new(|| {});
    let app_paths = resolve_app_paths(state);
    (ChatCallbacks { emit_event, notify_complete }, app_paths)
}

/// Run a blocking Claude history provider operation on the blocking thread pool.
/// Handles config cloning, spawn_blocking, and error mapping boilerplate.
pub async fn run_claude_blocking<F, T>(
    state: &AppState,
    f: F,
) -> Result<T, WebError>
where
    F: FnOnce(crate::ai::ClaudeHistoryProvider) -> crate::error::Result<T> + Send + 'static,
    T: Send + 'static,
{
    let config = state.clone_config_web()?;
    tokio::task::spawn_blocking(move || {
        let provider = crate::ai::ClaudeHistoryProvider::new(config);
        f(provider)
    })
    .await
    .map_err(|e| WebError::Internal(e.to_string()))?
    .map_err(WebError::from)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    pub message: String,
    pub session_id: Option<String>,
    #[serde(default)]
    pub options: Option<ChatRequestOptions>,
}

/// Send a chat message — creates a new session or continues an existing one.
pub async fn handle_send_message(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SendMessageRequest>,
) -> Result<impl IntoResponse, WebError> {
    let message = req.message.trim().to_string();
    if message.is_empty() {
        return Err(WebError::BadRequest("message must not be empty".to_string()));
    }

    let mut options = req.options.unwrap_or_default();
    let (callbacks, app_paths) = build_web_callbacks(&state, &mut options);

    match req.session_id {
        Some(session_id) => {
            validate_session_id(&session_id)?;
            continue_chat_inner(session_id, message, options, &state, callbacks, &app_paths)
                .await
                .map_err(|e| {
                    tracing::error!("[handle_send_message] continue_chat_inner 失败: {}", e);
                    e
                })?;
            Ok(ok_response())
        }
        None => {
            let sid = start_chat_inner(message, options, &state, callbacks, &app_paths)
                .await
                .map_err(|e| {
                    tracing::error!("[handle_send_message] start_chat_inner 失败: {}", e);
                    e
                })?;
            Ok(Json(serde_json::json!(sid)))
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptRequest {
    pub session_id: String,
    pub engine_id: Option<String>,
}

/// Interrupt an in-progress chat response.
pub async fn handle_interrupt(
    State(state): State<Arc<AppState>>,
    Json(req): Json<InterruptRequest>,
) -> Result<impl IntoResponse, WebError> {
    validate_session_id(&req.session_id)?;
    interrupt_chat_inner(req.session_id, req.engine_id, &state).await?;
    Ok(ok_response())
}

/// Get message history for a specific session.
/// Accepts optional `?page=1&page_size=50` query parameters.
/// Uses spawn_blocking to offload filesystem I/O from the async runtime.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    #[serde(default)]
    pub engine_id: Option<String>,
    #[serde(flatten)]
    pub pagination: PaginationQuery,
}

pub async fn handle_get_history(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(params): Query<HistoryQuery>,
) -> Result<impl IntoResponse, WebError> {
    validate_session_id(&session_id)?;

    let pagination = parse_pagination(&params.pagination);
    let engine = match params.engine_id.as_deref().unwrap_or("claude-code") {
        "claude" | "claude-code" => "claude-code",
        "codex" | "openai-codex" => "codex",
        other => return Err(WebError::BadRequest(format!("Unsupported engine: {}", other))),
    };

    let result = match engine {
        "claude-code" => run_claude_blocking(&state, move |provider| {
            provider.get_session_history(&session_id, pagination)
        }).await?,
        "codex" => {
            let config = state.clone_config_web()?;
            tokio::task::spawn_blocking(move || {
                let provider = crate::ai::CodexHistoryProvider::new(config);
                provider.get_session_history(&session_id, pagination)
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
pub struct AnswerQuestionRequest {
    pub session_id: String,
    pub call_id: String,
    pub selected: Vec<String>,
    pub custom_input: Option<String>,
}

/// Answer a pending AI question (tool-use confirmation, choice selection).
/// Returns 404 if the call_id does not exist in pending questions.
pub async fn handle_answer_question(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AnswerQuestionRequest>,
) -> Result<impl IntoResponse, WebError> {
    validate_session_id(&req.session_id)?;
    validate_entity_id(&req.call_id, "callId")?;

    let answer = QuestionAnswer {
        selected: req.selected,
        custom_input: req.custom_input,
    };
    let (call_id, session_id) = (req.call_id, req.session_id);

    {
        let mut pending = state.lock_pending_questions()?;
        let Some(question) = pending.get(&call_id) else {
            return Err(WebError::NotFound(format!("No pending question found for callId: {}", call_id)));
        };
        if question.session_id != session_id {
            return Err(WebError::BadRequest(format!(
                "session_id mismatch: expected {}, got {}",
                question.session_id, session_id
            )));
        }
        pending.remove(&call_id);
    }

    let event = serde_json::json!({
        "type": "question_answered",
        "sessionId": session_id,
        "callId": call_id,
        "answer": answer,
    });

    dual_emit(&state, &event);

    Ok(ok_response())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDecisionRequest {
    pub session_id: String,
    pub plan_id: String,
    pub feedback: Option<String>,
}

/// Shared handler for plan approve/reject — differs only in status and boolean flag.
async fn handle_plan_decision(
    state: &AppState,
    session_id: String,
    plan_id: String,
    feedback: Option<String>,
    approved: bool,
) -> Result<impl IntoResponse, WebError> {
    use crate::models::PlanApprovalResultEvent;

    {
        let mut pending = state.lock_pending_plans()?;
        let Some(plan) = pending.get(&plan_id) else {
            return Err(WebError::NotFound(format!("No pending plan found for planId: {}", plan_id)));
        };
        if plan.session_id != session_id {
            return Err(WebError::BadRequest(format!(
                "session_id mismatch: expected {}, got {}",
                plan.session_id, session_id
            )));
        }
        pending.remove(&plan_id);
    }

    let mut event = PlanApprovalResultEvent::new(&session_id, &plan_id, approved);
    if let Some(fb) = feedback {
        event = event.with_feedback(fb);
    }
    let payload = serde_json::json!({
        "contextId": "main",
        "payload": event
    });

    dual_emit(state, &payload);

    Ok(ok_response())
}

/// Approve a pending plan for execution.
/// Returns 404 if the plan_id does not exist in pending plans.
pub async fn handle_approve_plan(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PlanDecisionRequest>,
) -> Result<impl IntoResponse, WebError> {
    validate_session_id(&req.session_id)?;
    validate_entity_id(&req.plan_id, "planId")?;
    handle_plan_decision(&state, req.session_id, req.plan_id, req.feedback, true).await
}

/// Reject a pending plan, optionally with feedback.
/// Returns 404 if the plan_id does not exist in pending plans.
pub async fn handle_reject_plan(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PlanDecisionRequest>,
) -> Result<impl IntoResponse, WebError> {
    validate_session_id(&req.session_id)?;
    validate_entity_id(&req.plan_id, "planId")?;
    handle_plan_decision(&state, req.session_id, req.plan_id, req.feedback, false).await
}
