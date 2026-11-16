//! 事件包装与广播辅助（K-R3 拆分）

use serde_json::{json, Value};
use crate::state::AppState;

pub fn wrap_question_route_event(session_id: &str, payload: Value) -> Value {
    if session_id.trim().is_empty() {
        payload
    } else {
        json!({
            "contextId": format!("session-{}", session_id),
            "payload": payload,
        })
    }
}

pub fn emit_plugin_card_event(
    state: &AppState,
    session_id: &str,
    interaction_id: &str,
    plugin_id: &str,
    card_id: &str,
    tool_name: &str,
    payload: Value,
) {
    let event = wrap_question_route_event(
        session_id,
        json!({
            "type": "plugin_card",
            "sessionId": session_id,
            "interactionId": interaction_id,
            "pluginId": plugin_id,
            "cardId": card_id,
            "toolName": tool_name,
            "payload": payload,
        }),
    );
    emit_chat_event(state, &event);
}

pub fn emit_plugin_card_answered_event(
    state: &AppState,
    session_id: &str,
    interaction_id: &str,
    declined: bool,
    result: Value,
) {
    let event = wrap_question_route_event(
        session_id,
        json!({
            "type": "plugin_card_answered",
            "sessionId": session_id,
            "interactionId": interaction_id,
            "declined": declined,
            "result": result,
        }),
    );
    emit_chat_event(state, &event);
}

pub fn emit_chat_event(state: &AppState, event: &Value) {
    let ws_msg = serde_json::json!({
        "event": "chat-event",
        "payload": event,
    });
    if let Ok(msg) = serde_json::to_string(&ws_msg) {
        let _ = state.event_broadcast.send(msg);
    }

    #[cfg(feature = "tauri-app")]
    if let Some(handle) = state.app_handle.get() {
        use tauri::Emitter;
        if let Err(error) = handle.emit("chat-event", event) {
            tracing::warn!("[AskListener] emit chat-event 失败: {}", error);
        }
    }
}

// ============================================================================
// Frame I/O (u32 LE length prefix + UTF-8 JSON body)
// ============================================================================
