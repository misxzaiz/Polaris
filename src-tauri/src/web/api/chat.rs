use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;
use tauri::Emitter;

use crate::commands::chat::{ChatCallbacks, ChatRequestOptions, AppPaths, start_chat_inner, continue_chat_inner, interrupt_chat_inner};
use crate::state::QuestionAnswer;
use crate::AppState;
use super::super::error::WebError;

/// Validate that a session ID is safe to use (no path traversal, no special chars).
/// Session IDs should be alphanumeric with hyphens/underscores only (UUIDs, slugs).
pub fn validate_session_id(id: &str) -> Result<(), WebError> {
    validate_entity_id(id, "sessionId")
}

/// Validate a call/plan ID (alphanumeric + hyphens/underscores, max 128 chars).
fn validate_entity_id(id: &str, field: &str) -> Result<(), WebError> {
    if id.is_empty() {
        return Err(WebError::BadRequest(format!("{} must not be empty", field)));
    }
    if id.len() > 128 {
        return Err(WebError::BadRequest(format!("{} too long (max 128 chars)", field)));
    }
    if !id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err(WebError::BadRequest(format!("{} contains invalid characters", field)));
    }
    Ok(())
}

/// Resolve AppPaths (config_dir + resource_dir) from AppState.
/// Falls back to `dirs::config_dir()/claude-code-pro` if not set by Tauri setup.
pub fn resolve_app_paths(state: &AppState) -> AppPaths {
    let config_dir = state.app_config_dir.get()
        .cloned()
        .unwrap_or_else(|| {
            dirs::config_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("claude-code-pro")
        });
    let resource_dir = state.resource_dir.get()
        .and_then(|opt| opt.clone());
    AppPaths { config_dir, resource_dir }
}

/// Dual-emit: broadcast event to both WebSocket clients and Tauri webview.
pub fn dual_emit(state: &AppState, event: &serde_json::Value) {
    if let Err(e) = state.event_broadcast.send(event.to_string()) {
        tracing::warn!("WebSocket broadcast send failed (no active receivers): {}", e);
    }
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
    if options.context_id.is_none() {
        options.context_id = Some("web".to_string());
    }

    let emit_event = create_emit_callback(state.clone());
    let notify_complete = Arc::new(|| {});

    let callbacks = ChatCallbacks {
        emit_event,
        notify_complete,
    };

    let app_paths = resolve_app_paths(&state);

    match req.session_id {
        Some(session_id) => {
            validate_session_id(&session_id)?;
            continue_chat_inner(session_id, message, options, &state, callbacks, &app_paths)
                .await?;
            Ok(Json(serde_json::json!({ "status": "ok" })))
        }
        None => {
            let sid = start_chat_inner(message, options, &state, callbacks, &app_paths)
                .await?;
            Ok(Json(serde_json::json!({ "sessionId": sid })))
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
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

/// Get message history for a specific session.
/// Accepts optional `?page=1&page_size=50` query parameters.
/// Uses spawn_blocking to offload filesystem I/O from the async runtime.
pub async fn handle_get_history(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(params): Query<HistoryQueryParams>,
) -> Result<Json<serde_json::Value>, WebError> {
    use crate::ai::{ClaudeHistoryProvider, SessionHistoryProvider, Pagination};

    validate_session_id(&session_id)?;

    let page = params.page.unwrap_or(1).max(1);
    let page_size = params.page_size.unwrap_or(50).clamp(1, 200);

    let blocking_task = {
        let config = state.clone_config()
            .map_err(WebError::Internal)?;

        let pagination = Pagination::new(page, page_size);
        tokio::task::spawn_blocking(move || {
            let provider = ClaudeHistoryProvider::new(config);
            provider.get_session_history(&session_id, pagination)
        })
    };

    let result = blocking_task.await
        .map_err(|e| WebError::Internal(e.to_string()))?
        .map_err(WebError::from)?;

    Ok(Json(serde_json::json!(result)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQueryParams {
    page: Option<usize>,
    page_size: Option<usize>,
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
        let mut pending = state.pending_questions.lock()
            .map_err(|e| WebError::Internal(e.to_string()))?;
        let Some(question) = pending.get_mut(&call_id) else {
            return Err(WebError::NotFound(format!("No pending question found for callId: {}", call_id)));
        };
        use crate::state::QuestionStatus;
        question.status = QuestionStatus::Answered;
        pending.remove(&call_id);
    }

    let event = serde_json::json!({
        "type": "question_answered",
        "sessionId": session_id,
        "callId": call_id,
        "answer": answer,
    });

    dual_emit(&state, &event);

    Ok(Json(serde_json::json!({ "status": "ok" })))
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
    use crate::state::PlanApprovalStatus;
    use crate::models::PlanApprovalResultEvent;

    {
        let mut pending = state.pending_plans.lock()
            .map_err(|e| WebError::Internal(e.to_string()))?;
        let Some(plan) = pending.get_mut(&plan_id) else {
            return Err(WebError::NotFound(format!("No pending plan found for planId: {}", plan_id)));
        };
        plan.status = if approved { PlanApprovalStatus::Approved } else { PlanApprovalStatus::Rejected };
        plan.feedback = feedback.clone();
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

    Ok(Json(serde_json::json!({ "status": "ok" })))
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
