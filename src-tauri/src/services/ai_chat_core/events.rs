//! 事件广播与 session_events 影子写入（K-R6 自 ai_chat_core.rs 迁入）

/// 后端内部路径的设备标识（dispatch 链路由后端自身触发，无前端 deviceId）
const SESSION_EVENT_DEVICE_ID: &str = "core";

// ============================================================================
// Tauri Commands - 聊天
// ============================================================================

/// 将 chat 事件包装为 WS envelope 后广播。
///
/// 前端 HTTP 传输层（httpTransport）按顶层 `event` 字段路由事件，
/// 未包 envelope 的裸事件会被 Web 客户端静默丢弃 —— 桌面端发起的会话
/// 在手机/浏览器端将完全看不到流式输出。格式与 `web::api::chat::dual_emit`
/// 的 WebSocket 分支保持一致。
pub(super) fn broadcast_chat_event(tx: &crate::web::EventBroadcaster, event: &serde_json::Value) {
    let ws_msg = serde_json::json!({
        "event": "chat-event",
        "payload": event,
    });
    let _ = tx.send(ws_msg.to_string());
}

pub(super) fn wrap_session_routed_event(session_id: &str, payload: serde_json::Value) -> serde_json::Value {
    if session_id.trim().is_empty() {
        payload
    } else {
        serde_json::json!({
            "contextId": format!("session-{}", session_id),
            "payload": payload,
        })
    }
}

/// 追加一条 session_state 事件（影子写入；失败仅告警不阻断主流程）。
///
/// 依据 `07-阶段4实施方案.md` 批次 4：`router_dispatch_stream` start/continue 时
/// 写 `session_start`，session_end 时写 `session_end`（带 reason）。旧业务路径零改动，
/// 事件日志仅作后端权威状态的输入，不参与引擎控制流。
pub fn append_session_event(
    conversation_id: &str,
    event_type: crate::services::session_state::SessionEventType,
    reason: Option<String>,
    error_message: Option<String>,
) {
    if conversation_id.trim().is_empty() {
        return
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_else(|_| 0);
    let event = crate::services::session_state::SessionEventEntry {
        id: format!(
            "core-{}-{}",
            event_type.as_str(),
            uuid::Uuid::new_v4()
        ),
        conversation_id: conversation_id.to_string(),
        event_type,
        timestamp: ts,
        device_id: SESSION_EVENT_DEVICE_ID.to_string(),
        seq: 0, // 占位；由底层 next_seq 分配
        reason,
        error_message,
    };
    // seq 分配与写入封装在命令层 inner（next_seq + append_event 事务一致）
    let _ = crate::commands::session_state_commands::session_event_append_with_seq_inner(&event);
}
