use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;
use tauri::Emitter;

use crate::commands::chat::{ChatCallbacks, ChatRequestOptions, AppPaths, start_chat_inner, continue_chat_inner, interrupt_chat_inner};
use crate::state::QuestionAnswer;
use crate::AppState;
use super::super::error::WebError;

/// Dual-emit: broadcast event to both WebSocket clients and Tauri webview.
fn dual_emit(state: &AppState, event: &serde_json::Value) {
    if let Err(e) = state.event_broadcast.send(event.to_string()) {
        tracing::warn!("WebSocket broadcast send failed (no active receivers): {}", e);
    }
    if let Some(handle) = state.app_handle.get() {
        if let Err(e) = handle.emit("chat-event", event) {
            tracing::warn!("Tauri webview emit failed: {}", e);
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    pub message: String,
    pub session_id: Option<String>,
    #[serde(default)]
    pub options: Option<ChatRequestOptions>,
}

pub async fn handle_send_message(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SendMessageRequest>,
) -> Result<impl IntoResponse, WebError> {
    let mut options = req.options.unwrap_or_default();
    if options.context_id.is_none() {
        options.context_id = Some("web".to_string());
    }

    let emit_event = {
        let state = state.clone();
        Arc::new(move |json: serde_json::Value| {
            dual_emit(&state, &json);
        })
    };
    let notify_complete = Arc::new(|| {});

    let callbacks = ChatCallbacks {
        emit_event,
        notify_complete,
    };

    // Default AppPaths — web mode has no Tauri window, use standard config dir
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("claude-code-pro");
    let app_paths = AppPaths {
        config_dir,
        resource_dir: None,
    };

    match req.session_id {
        Some(session_id) => {
            continue_chat_inner(session_id, req.message, options, &state, callbacks, &app_paths)
                .await?;
            Ok(Json(serde_json::json!({ "status": "ok" })))
        }
        None => {
            let sid = start_chat_inner(req.message, options, &state, callbacks, &app_paths)
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

pub async fn handle_interrupt(
    State(state): State<Arc<AppState>>,
    Json(req): Json<InterruptRequest>,
) -> Result<impl IntoResponse, WebError> {
    interrupt_chat_inner(req.session_id, req.engine_id, &state).await?;
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

pub async fn handle_get_history(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, WebError> {
    use crate::ai::{ClaudeHistoryProvider, SessionHistoryProvider, Pagination};

    let config_store = state.config_store.lock()
        .map_err(|e| WebError::Internal(e.to_string()))?;
    let config = config_store.get().clone();
    drop(config_store);

    let pagination = Pagination::new(1, 50);
    let provider = ClaudeHistoryProvider::new(config);
    let result = provider.get_session_history(&session_id, pagination)?;
    Ok(Json(serde_json::json!(result)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerQuestionRequest {
    pub session_id: String,
    pub call_id: String,
    pub selected: Vec<String>,
    pub custom_input: Option<String>,
}

pub async fn handle_answer_question(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AnswerQuestionRequest>,
) -> Result<impl IntoResponse, WebError> {
    let answer = QuestionAnswer {
        selected: req.selected,
        custom_input: req.custom_input,
    };

    {
        let mut pending = state.pending_questions.lock()
            .map_err(|e| WebError::Internal(e.to_string()))?;
        if let Some(question) = pending.get_mut(&req.call_id) {
            use crate::state::QuestionStatus;
            question.status = QuestionStatus::Answered;
        }
    }

    let event = serde_json::json!({
        "type": "question_answered",
        "sessionId": req.session_id,
        "callId": req.call_id,
        "answer": answer,
    });

    dual_emit(&state, &event);

    Ok(Json(serde_json::json!({ "status": "ok" })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovePlanRequest {
    pub session_id: String,
    pub plan_id: String,
    pub feedback: Option<String>,
}

pub async fn handle_approve_plan(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ApprovePlanRequest>,
) -> Result<impl IntoResponse, WebError> {
    use crate::state::PlanApprovalStatus;
    use crate::models::PlanApprovalResultEvent;

    {
        let mut pending = state.pending_plans.lock()
            .map_err(|e| WebError::Internal(e.to_string()))?;
        if let Some(plan) = pending.get_mut(&req.plan_id) {
            plan.status = PlanApprovalStatus::Approved;
        }
    }

    let event = PlanApprovalResultEvent::new(&req.session_id, &req.plan_id, true);
    let payload = serde_json::json!({
        "contextId": "main",
        "payload": event
    });

    dual_emit(&state, &payload);

    Ok(Json(serde_json::json!({ "status": "ok" })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectPlanRequest {
    pub session_id: String,
    pub plan_id: String,
    pub feedback: Option<String>,
}

pub async fn handle_reject_plan(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RejectPlanRequest>,
) -> Result<impl IntoResponse, WebError> {
    use crate::state::PlanApprovalStatus;
    use crate::models::PlanApprovalResultEvent;

    {
        let mut pending = state.pending_plans.lock()
            .map_err(|e| WebError::Internal(e.to_string()))?;
        if let Some(plan) = pending.get_mut(&req.plan_id) {
            plan.status = PlanApprovalStatus::Rejected;
            plan.feedback = req.feedback.clone();
        }
    }

    let event = PlanApprovalResultEvent::new(&req.session_id, &req.plan_id, false)
        .with_feedback(req.feedback.unwrap_or_default());
    let payload = serde_json::json!({
        "contextId": "main",
        "payload": event
    });

    dual_emit(&state, &payload);

    Ok(Json(serde_json::json!({ "status": "ok" })))
}
