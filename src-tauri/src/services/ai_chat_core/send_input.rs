//! stdin 输入（K-R6 自 ai_chat_core.rs 迁入）

use crate::error::Result;

// ============================================================================
// stdin 输入相关命令
// ============================================================================

/// 向会话发送输入
///
/// 通过 stdin 向运行中的会话发送输入数据
pub async fn send_input(
    session_id: String,
    input: String,
    state: &crate::AppState,
) -> Result<bool> {
    tracing::info!(
        "[send_input] 向会话 {} 发送输入: {} bytes",
        session_id,
        input.len()
    );

    let mut registry = state.engine_registry.lock().await;
    registry.send_input(&session_id, &input)
}
