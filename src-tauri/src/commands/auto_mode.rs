//! Auto-Mode Tauri 命令
//!
//! 提供自动模式配置的 API 接口

#[cfg(feature = "tauri-app")]
use tauri::State;

use crate::error::Result;
use crate::models::auto_mode::{AutoModeConfig, AutoModeDefaults};
use crate::services::auto_mode_service::AutoModeService;
use crate::state::AppState;

/// 获取 Claude CLI 路径
#[cfg(feature = "tauri-app")]
fn get_claude_path(state: &State<'_, AppState>) -> Result<String> {
    let store = state.config_store.lock()
        .map_err(|e| crate::error::AppError::Unknown(e.to_string()))?;
    Ok(store.get().get_claude_cmd())
}

/// 获取自动模式配置
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn auto_mode_config(state: State<'_, AppState>) -> Result<AutoModeConfig> {
    let claude_path = get_claude_path(&state)?;
    let service = AutoModeService::new(claude_path);
    service.get_config()
}

/// 获取默认配置
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn auto_mode_defaults(state: State<'_, AppState>) -> Result<AutoModeDefaults> {
    let claude_path = get_claude_path(&state)?;
    let service = AutoModeService::new(claude_path);
    service.get_defaults()
}
