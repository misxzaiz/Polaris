//! cancel 帧处理（K-R3 拆分）

use super::types::QuestionOutcome;
use super::emit::emit_plugin_card_answered_event;
use super::types::PluginCardOutcome;

use serde_json::Value;
use std::sync::Arc;
use crate::state::AppState;

pub fn handle_cancel_frame(frame: Value, state: Arc<AppState>, expected_token: &str) {
    let token = frame
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if token != expected_token {
        tracing::warn!("[AskListener] cancel token 不匹配");
        return;
    }
    let call_id = frame
        .get("callId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if call_id.is_empty() {
        return;
    }
    if let Some(entry) = state.take_ask_answer_sender(&call_id) {
        let _ = entry.sender.send(QuestionOutcome::declined());
    }
    if let Ok(mut pending) = state.pending_questions.lock() {
        pending.remove(&call_id);
    }
}

pub fn handle_card_cancel_frame(frame: Value, state: Arc<AppState>, expected_token: &str) {
    let token = frame
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if token != expected_token {
        tracing::warn!("[AskListener] card_cancel token 不匹配");
        return;
    }
    let interaction_id = frame
        .get("interactionId")
        .or_else(|| frame.get("callId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if interaction_id.is_empty() {
        return;
    }
    let session_id = state
        .pending_plugin_cards
        .lock()
        .ok()
        .and_then(|pending| {
            pending
                .get(&interaction_id)
                .map(|card| card.session_id.clone())
        })
        .unwrap_or_default();
    if let Some(entry) = state.take_plugin_card_answer_sender(&interaction_id) {
        let _ = entry.sender.send(PluginCardOutcome::declined());
    }
    if let Ok(mut pending) = state.pending_plugin_cards.lock() {
        pending.remove(&interaction_id);
    }
    emit_plugin_card_answered_event(&state, &session_id, &interaction_id, true, Value::Null);
}
