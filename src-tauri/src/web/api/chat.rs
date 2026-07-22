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
/// Falls back to DataRoot if not set by Tauri setup.
pub fn resolve_app_paths(state: &AppState) -> AppPaths {
    let config_dir = state.app_config_dir.get()
        .cloned()
        .unwrap_or_else(|| {
            let fallback = crate::services::data_root::data_root().config_dir();
            tracing::debug!("app_config_dir not set, using DataRoot fallback: {:?}", fallback);
            fallback
        });
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

fn wrap_session_routed_event(session_id: &str, payload: serde_json::Value) -> serde_json::Value {
    if session_id.trim().is_empty() {
        payload
    } else {
        serde_json::json!({
            "contextId": format!("session-{}", session_id),
            "payload": payload,
        })
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
    /// 嵌套形态：与 Tauri 命令 `answer_question(.., answer: QuestionAnswer)` 参数对齐。
    /// 前端 `invoke('answer_question', { sessionId, callId, answer: { answers, declined } })`
    /// 经 httpTransport 整体作为 body POST，`answers`/`declined` 嵌在 `answer` 里。
    /// 若不兼容此字段，Web 模式下 `req.answers` 恒为空，回填 MCP companion 的 selected 恒为 []。
    #[serde(default)]
    pub answer: Option<crate::state::QuestionAnswer>,
    /// 扁平兼容字段：直发的多题答案数组
    #[serde(default)]
    pub answers: Vec<crate::state::SubAnswer>,
    /// 扁平兼容字段：是否整体跳过
    #[serde(default)]
    pub declined: bool,
    // ===== 兼容字段：旧版单题 payload =====
    #[serde(default)]
    pub selected: Option<Vec<String>>,
    #[serde(default)]
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

    // 优先取嵌套 `answer`（Web 端 httpTransport 把 invoke args 整体作为 body 发送，
    // 与 Tauri 命令 `answer_question(.., answer: QuestionAnswer)` 参数结构一致）。
    // 再回退到扁平 `answers`/`declined`，最后回退到旧版单题 `selected`/`customInput`。
    let (answers, declined) = if let Some(answer) = req.answer {
        if !answer.answers.is_empty() {
            (answer.answers, answer.declined)
        } else if let Some(selected) = req.selected {
            (
                vec![crate::state::SubAnswer {
                    selected,
                    custom_input: req.custom_input,
                    declined: false,
                }],
                answer.declined,
            )
        } else {
            (Vec::new(), answer.declined)
        }
    } else if !req.answers.is_empty() {
        (req.answers, req.declined)
    } else if req.selected.is_some() || req.custom_input.is_some() {
        (
            vec![crate::state::SubAnswer {
                selected: req.selected.unwrap_or_default(),
                custom_input: req.custom_input,
                declined: false,
            }],
            req.declined,
        )
    } else {
        (Vec::new(), req.declined)
    };

    let answer = QuestionAnswer {
        answers,
        declined,
    };
    let call_id = req.call_id;

    let backend_session_id = {
        let mut pending = state.lock_pending_questions()?;
        let Some(question) = pending.get(&call_id) else {
            return Err(WebError::NotFound(format!("No pending question found for callId: {}", call_id)));
        };
        // call_id 是 pending 表的强主键，足以唯一确定这条待回答问题；
        // 不再比对前端传入的 sessionId —— Web 模式前端 sessionId 是本地 UUID，
        // 与后端 MCP 引擎会话 ID 必然不同，强制比对会导致提交永远 400。
        // 改用 pending 表里真实的后端 sessionId 作为后续事件回路的会话标识。
        let backend_sid = question.session_id.clone();
        pending.remove(&call_id);
        backend_sid
    };

    // 通过 ask_listener oneshot 将答案推回 MCP companion（如果存在）。
    if let Some(entry) = state.take_ask_answer_sender(&call_id) {
        let outcome = crate::services::ask_listener::build_outcome_for_multiple_answers(
            &entry,
            answer.answers.clone(),
            answer.declined,
        );
        let _ = entry.sender.send(outcome);
    }

    // 旧测试断言可能引用 answer.selected/customInput，这里同时挂上首题摘要兼容字段
    let first = answer.answers.first().cloned().unwrap_or_default();
    let event = serde_json::json!({
        "type": "question_answered",
        "sessionId": backend_session_id,
        "questionId": call_id,
        "callId": call_id,  // 兼容字段
        "answers": answer.answers,
        "declined": answer.declined,
        // 兼容字段：首题摘要
        "answer": {
            "selected": first.selected,
            "customInput": first.custom_input,
        },
    });

    let routed_event = wrap_session_routed_event(&backend_session_id, event);
    dual_emit(&state, &routed_event);

    Ok(ok_response())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespondPluginCardRequest {
    pub session_id: String,
    pub interaction_id: String,
    #[serde(default)]
    pub result: serde_json::Value,
    #[serde(default)]
    pub declined: bool,
    #[serde(default)]
    pub response: Option<RespondPluginCardPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespondPluginCardPayload {
    #[serde(default)]
    pub result: serde_json::Value,
    #[serde(default)]
    pub declined: bool,
}

/// Answer a pending plugin interaction card.
pub async fn handle_respond_plugin_card(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RespondPluginCardRequest>,
) -> Result<impl IntoResponse, WebError> {
    validate_session_id(&req.session_id)?;
    validate_entity_id(&req.interaction_id, "interactionId")?;
    let result = req
        .response
        .as_ref()
        .map(|response| response.result.clone())
        .unwrap_or_else(|| req.result.clone());
    let declined = req
        .response
        .as_ref()
        .map(|response| response.declined)
        .unwrap_or(req.declined);

    {
        let mut pending = state
            .pending_plugin_cards
            .lock()
            .map_err(|e| WebError::Internal(e.to_string()))?;
        if let Some(card) = pending.get(&req.interaction_id) {
            if card.session_id != req.session_id {
                return Err(WebError::BadRequest(format!(
                    "session_id mismatch: expected {}, got {}",
                    card.session_id, req.session_id
                )));
            }
        } else {
            return Err(WebError::NotFound(format!(
                "No pending plugin card found for interactionId: {}",
                req.interaction_id
            )));
        }
        pending.remove(&req.interaction_id);
    }

    let outcome = if declined {
        crate::services::ask_listener::PluginCardOutcome::declined()
    } else {
        crate::services::ask_listener::PluginCardOutcome::answer(result.clone())
    };
    if let Some(entry) = state.take_plugin_card_answer_sender(&req.interaction_id) {
        let _ = entry.sender.send(outcome);
    }

    let event = serde_json::json!({
        "type": "plugin_card_answered",
        "sessionId": req.session_id,
        "interactionId": req.interaction_id,
        "declined": declined,
        "result": result,
    });
    let routed_event = wrap_session_routed_event(&req.session_id, event);
    dual_emit(&state, &routed_event);

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
