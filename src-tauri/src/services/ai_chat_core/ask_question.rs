//! AskUserQuestion pending 队列（K-R6 自 ai_chat_core.rs 迁入）

use crate::state::{PendingQuestion, QuestionAnswer, QuestionOption, QuestionStatus};
use crate::error::{AppError, Result};
use super::events::*;

// ============================================================================
// 阶段 4 批次 4：dispatch 链路附加 session_events 写入（影子运行）
// ============================================================================

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCardResponse {
    #[serde(default)]
    pub result: serde_json::Value,
    #[serde(default)]
    pub declined: bool,
}

/// 注册待回答问题
///
/// 当收到 ask_user_question 工具调用时调用此函数
pub fn register_pending_question(
    session_id: String,
    call_id: String,
    header: String,
    multi_select: bool,
    options: Vec<QuestionOption>,
    allow_custom_input: bool,
    state: &crate::AppState,
) -> Result<()> {
    tracing::info!(
        "[register_pending_question] 注册问题: session={}, call={}, header={}",
        session_id,
        call_id,
        header
    );

    let question = PendingQuestion {
        call_id: call_id.clone(),
        session_id,
        questions: vec![crate::state::QuestionItem {
            question: header.clone(),
            header,
            multi_select,
            options,
            allow_custom_input,
        }],
        status: QuestionStatus::Pending,
    };

    let mut pending = state
        .pending_questions
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    pending.insert(call_id, question);

    Ok(())
}

/// 回答问题
///
/// 用户提交答案后调用此函数。会做两件事：
///   1. 取出 ask_listener 注册的 oneshot::Sender，触发同回合 tool_result 回填
///   2. emit `question_answered` 让前端把卡片切到已答态
pub async fn answer_question(
    session_id: String,
    call_id: String,
    answer: QuestionAnswer,
    state: &crate::AppState,
) -> Result<()> {
    tracing::info!(
        "[answer_question] 回答问题: session={}, call={}, sub_answers={}, declined={}",
        session_id,
        call_id,
        answer.answers.len(),
        answer.declined,
    );

    // 1. 取出 ask_listener 注册的 oneshot::Sender，把答案推回 MCP companion。
    //    如果没有 sender（旧路径未走 MCP），则降级为只做事件广播。
    if let Some(entry) = state.take_ask_answer_sender(&call_id) {
        let outcome = crate::services::ask_listener::build_outcome_for_multiple_answers(
            &entry,
            answer.answers.clone(),
            answer.declined,
        );
        if entry.sender.send(outcome).is_err() {
            tracing::warn!("[answer_question] oneshot 接收端已关闭: {}", call_id);
        }
    } else {
        tracing::debug!(
            "[answer_question] 无 ask_listener sender，按 legacy 路径处理: {}",
            call_id
        );
        // legacy 路径：无 ask_listener 引擎，问题回答走通用流程
        tracing::debug!(
            "[answer_question] legacy 路径下无引擎可提交答案: {}",
            call_id
        );
    }

    // 2. 清理 pending_questions（ask_listener 也会清理，这里做幂等）
    {
        let mut pending = state
            .pending_questions
            .lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;
        pending.remove(&call_id);
    }

    // 3. emit `question_answered`，前端把卡片切到 answered
    let first = answer.answers.first().cloned().unwrap_or_default();
    let event = serde_json::json!({
        "type": "question_answered",
        "sessionId": session_id,
        "questionId": call_id,
        "callId": call_id,  // 兼容字段
        "answers": answer.answers,
        "declined": answer.declined,
        // 兼容字段：旧 answer 单题摘要
        "answer": {
            "selected": first.selected,
            "customInput": first.custom_input,
        },
    });

    let routed_event = wrap_session_routed_event(&session_id, event);

    // Dual emission: also broadcast to WebSocket clients
    broadcast_chat_event(&state.event_broadcast, &routed_event);

    tracing::info!("[answer_question] 答案已提交，事件已发送");

    Ok(())
}

/// 回答插件交互卡片。
///
/// 取出 ask_listener 注册的 oneshot::Sender，将结果回填给插件 MCP server，
/// 再广播 `plugin_card_answered` 让前端卡片切换到已处理状态。
pub async fn respond_plugin_card(
    session_id: String,
    interaction_id: String,
    response: PluginCardResponse,
    state: &crate::AppState,
) -> Result<()> {
    tracing::info!(
        "[respond_plugin_card] 回答插件卡片: session={}, interaction={}, declined={}",
        session_id,
        interaction_id,
        response.declined,
    );

    {
        let mut pending = state
            .pending_plugin_cards
            .lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;
        if let Some(card) = pending.get(&interaction_id) {
            if card.session_id != session_id {
                return Err(AppError::ValidationError(format!(
                    "session_id mismatch: expected {}, got {}",
                    card.session_id, session_id
                )));
            }
        }
        pending.remove(&interaction_id);
    }

    let result = response.result.clone();
    let outcome = if response.declined {
        crate::services::ask_listener::PluginCardOutcome::declined()
    } else {
        crate::services::ask_listener::PluginCardOutcome::answer(result.clone())
    };
    if let Some(entry) = state.take_plugin_card_answer_sender(&interaction_id) {
        if entry.sender.send(outcome).is_err() {
            tracing::warn!(
                "[respond_plugin_card] oneshot 接收端已关闭: {}",
                interaction_id
            );
        }
    } else {
        tracing::debug!(
            "[respond_plugin_card] 无 plugin card sender，按事件广播处理: {}",
            interaction_id
        );
    }

    let event = serde_json::json!({
        "type": "plugin_card_answered",
        "sessionId": session_id,
        "interactionId": interaction_id,
        "declined": response.declined,
        "result": result,
    });
    let routed_event = wrap_session_routed_event(&session_id, event);
    broadcast_chat_event(&state.event_broadcast, &routed_event);

    Ok(())
}

/// 获取待回答问题列表
pub fn get_pending_questions(
    session_id: Option<String>,
    state: &crate::AppState,
) -> Result<Vec<PendingQuestion>> {
    let pending = state
        .pending_questions
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;

    let questions: Vec<PendingQuestion> = pending
        .values()
        .filter(|q| {
            if let Some(ref sid) = session_id {
                &q.session_id == sid
            } else {
                true
            }
        })
        .filter(|q| matches!(q.status, QuestionStatus::Pending))
        .cloned()
        .collect();

    Ok(questions)
}

/// 清除已回答的问题
pub fn clear_answered_questions(state: &crate::AppState) -> Result<usize> {
    let mut pending = state
        .pending_questions
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;

    let initial_count = pending.len();
    pending.retain(|_, q| matches!(q.status, QuestionStatus::Pending));
    let removed = initial_count - pending.len();

    tracing::info!("[clear_answered_questions] 清除了 {} 个已回答问题", removed);

    Ok(removed)
}

