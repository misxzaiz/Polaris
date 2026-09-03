//! 心灵伙伴命令 — `/here` 入口
//!
//! Phase 0：用户在对话输入框输入 `/here` 触发。
//! 后端采集快照 → 读取记忆 → 调用 LLM 决策 → 写入新记忆 → 返回回应。

use crate::error::Result;
use crate::services::companion_agent;

/// `/here` 命令：触发心灵伙伴决策
///
/// - 桌面端（tauri-app）：作为 Tauri command 注册，前端通过 `invoke('companion_here', { sessionActive })` 调用
/// - Web 模式：通过 HTTP bridge 路由到 `companion_here_web`
///
/// `session_active` 表示当前是否有进行中的 AI 会话。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn companion_here(
    state: tauri::State<'_, crate::AppState>,
    session_active: bool,
) -> Result<String> {
    let config = state.clone_config().map_err(|e| {
        crate::error::AppError::ConfigError(format!("读取配置失败: {}", e))
    })?;
    companion_agent::companion_here(config, session_active).await
}

/// Web 模式（HTTP bridge）下的入口
pub async fn companion_here_web(
    config: crate::models::config::Config,
    session_active: bool,
) -> Result<String> {
    companion_agent::companion_here(config, session_active).await
}