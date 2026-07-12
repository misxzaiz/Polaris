//! CLI 信息查询 Tauri 命令
//!
//! 提供 CLI 动态数据查询的 API 接口 (agents, auth status, version, check installed)

#[cfg(feature = "tauri-app")]
use tauri::State;

use crate::error::Result;
use crate::models::cli_info::{CliAgentInfo, CliAuthStatus};
use crate::services::cli_info_service::{CliInfoService, check_cli_installed, get_cli_version};
use crate::state::AppState;

/// 获取 Claude CLI 路径
#[cfg(feature = "tauri-app")]
fn get_claude_path(state: &State<'_, AppState>) -> Result<String> {
    let store = state.config_store.lock()
        .map_err(|e| crate::error::AppError::Unknown(e.to_string()))?;
    Ok(store.get().get_claude_cmd())
}

/// 获取 CLI Agent 列表
///
/// 调用 `claude agents` 获取动态 Agent 列表
#[cfg(feature = "tauri-app")]
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
#[cfg(feature = "tauri-app")]
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
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn cli_get_version(
    state: State<'_, AppState>,
) -> Result<String> {
    let claude_path = get_claude_path(&state)?;
    let service = CliInfoService::new(claude_path);
    service.get_version()
}

/// 运行 ultrareview 云端代码审查
///
/// 在工作区目录执行 `claude ultrareview [target]`，返回格式化的审查结果
/// （markdown 文本）。云端审查耗时较长，放入阻塞线程池执行，避免阻塞
/// async runtime；超时由 CLI 的 `--timeout` 控制（默认 30 分钟）。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn cli_run_ultrareview(
    state: State<'_, AppState>,
    workspace_dir: String,
    target: Option<String>,
    timeout_mins: Option<u32>,
) -> Result<String> {
    let claude_path = get_claude_path(&state)?;
    let timeout = timeout_mins.unwrap_or(30);

    tokio::task::spawn_blocking(move || {
        let service = CliInfoService::new(claude_path);
        service.run_ultrareview(&workspace_dir, target.as_deref(), timeout, false)
    })
    .await
    .map_err(|e| crate::error::AppError::Unknown(format!("ultrareview 任务执行失败: {}", e)))?
}

/// 结构化提取（`--json-schema`）
///
/// 以自然语言 `prompt` 为输入、`schema_json` 为 JSON Schema 约束，调用
/// `claude --print --output-format json --json-schema <schema>`，返回 CLI 的
/// 完整 JSON stdout（结构化结果由前端 service 层解包）。会真实调用模型，
/// 放入阻塞线程池执行以避免阻塞 async runtime。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn cli_extract_structured(
    state: State<'_, AppState>,
    prompt: String,
    schema_json: String,
    workspace_dir: Option<String>,
    model: Option<String>,
) -> Result<String> {
    let claude_path = get_claude_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let service = CliInfoService::new(claude_path);
        service.extract_structured(
            &prompt,
            &schema_json,
            workspace_dir.as_deref(),
            model.as_deref(),
        )
    })
    .await
    .map_err(|e| crate::error::AppError::Unknown(format!("结构化提取任务执行失败: {}", e)))?
}

/// 检查指定 CLI 是否已安装
///
/// 使用 which/where 命令查找可执行文件
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn cli_check_installed(cli_name: String) -> bool {
    check_cli_installed(&cli_name)
}

/// 查找指定 CLI 的所有可用完整路径
///
/// 使用 which/where 命令解析 PATH 中的实际安装位置（绝对路径）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn cli_find_paths(cli_name: String) -> Vec<String> {
    crate::services::cli_info_service::find_cli_paths(&cli_name)
}

/// 获取指定 CLI 的版本
///
/// 执行 `<cli_name> --version` 获取版本信息
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn cli_get_version_for(cli_name: String) -> Result<String> {
    get_cli_version(&cli_name)
}
