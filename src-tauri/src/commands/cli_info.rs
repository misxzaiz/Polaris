//! CLI 信息查询 Tauri 命令
//!
//! 提供 CLI 动态数据查询的 API 接口 (agents, auth status, version, check installed)

use tauri::State;

use crate::error::Result;
use crate::models::cli_info::{CliAgentInfo, CliAuthStatus};
use crate::services::cli_info_service::{CliInfoService, check_cli_installed, get_cli_version};
use crate::state::AppState;

/// 获取 Claude CLI 路径
fn get_claude_path(state: &State<'_, AppState>) -> Result<String> {
    let store = state.config_store.lock()
        .map_err(|e| crate::error::AppError::Unknown(e.to_string()))?;
    Ok(store.get().get_claude_cmd())
}

/// 获取 CLI Agent 列表
///
/// 调用 `claude agents` 获取动态 Agent 列表
#[tauri::command]
pub async fn cli_get_agents(
    state: State<'_, AppState>,
) -> Result<Vec<CliAgentInfo>> {
    let claude_path = get_claude_path(&state)?;
    let service = CliInfoService::new(claude_path);
    service.get_agents()
}

/// 获取 CLI 认证状态
///
/// 调用 `claude auth status` 获取当前认证信息
#[tauri::command]
pub async fn cli_get_auth_status(
    state: State<'_, AppState>,
) -> Result<CliAuthStatus> {
    let claude_path = get_claude_path(&state)?;
    let service = CliInfoService::new(claude_path);
    service.get_auth_status()
}

/// 获取 CLI 版本号
///
/// 调用 `claude --version` 获取版本信息
#[tauri::command]
pub async fn cli_get_version(
    state: State<'_, AppState>,
) -> Result<String> {
    let claude_path = get_claude_path(&state)?;
    let service = CliInfoService::new(claude_path);
    service.get_version()
}

/// 检查指定 CLI 是否已安装
///
/// 使用 which/where 命令查找可执行文件
#[tauri::command]
pub fn cli_check_installed(cli_name: String) -> bool {
    check_cli_installed(&cli_name)
}

/// 获取指定 CLI 的版本
///
/// 执行 `<cli_name> --version` 获取版本信息
#[tauri::command]
pub async fn cli_get_version_for(cli_name: String) -> Result<String> {
    get_cli_version(&cli_name)
}
