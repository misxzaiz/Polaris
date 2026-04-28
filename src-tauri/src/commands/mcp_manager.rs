//! MCP 管理器 Tauri 命令
//!
//! 提供 MCP 服务器列表、详情、健康检查、添加、移除等 API 接口

#[cfg(feature = "tauri-app")]
use tauri::State;

use crate::error::Result;
use crate::services::mcp_manager_service::{McpHealthStatus, McpManagerService, McpServerAggregate};
use crate::state::AppState;

/// 获取 Claude CLI 路径
#[cfg(feature = "tauri-app")]
fn get_claude_path(state: &State<'_, AppState>) -> Result<String> {
    let store = state
        .config_store
        .lock()
        .map_err(|e| crate::error::AppError::Unknown(e.to_string()))?;
    Ok(store.get().get_claude_cmd())
}

/// 列出所有 MCP 服务器（聚合配置 + 健康状态）
///
/// 读取指定工作区下的所有 MCP 配置文件，并结合运行时健康检查返回聚合视图
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn mcp_list_servers(
    workspace_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<McpServerAggregate>> {
    let claude_path = get_claude_path(&state)?;
    let service = McpManagerService::new(claude_path);
    service.list_servers(&workspace_path)
}

/// 获取单个 MCP 服务器的聚合信息
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn mcp_get_server(
    name: String,
    workspace_path: String,
    state: State<'_, AppState>,
) -> Result<McpServerAggregate> {
    let claude_path = get_claude_path(&state)?;
    let service = McpManagerService::new(claude_path);
    service.get_server(&name, &workspace_path)
}

/// 对所有 MCP 服务器执行健康检查
///
/// 调用 `claude mcp list` 获取运行时状态
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn mcp_health_check(
    state: State<'_, AppState>,
) -> Result<Vec<McpHealthStatus>> {
    let claude_path = get_claude_path(&state)?;
    let service = McpManagerService::new(claude_path);
    service.health_check()
}

/// 对单个 MCP 服务器执行健康检查
///
/// 调用 `claude mcp get <name>` 获取运行时状态
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn mcp_health_check_one(
    name: String,
    state: State<'_, AppState>,
) -> Result<McpHealthStatus> {
    let claude_path = get_claude_path(&state)?;
    let service = McpManagerService::new(claude_path);
    service.health_check_one(&name)
}

/// 添加 MCP 服务器
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn mcp_add_server(
    name: String,
    command: String,
    args: Vec<String>,
    transport: String,
    scope: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let claude_path = get_claude_path(&state)?;
    let service = McpManagerService::new(claude_path);
    service.add_server(&name, &command, &args, &transport, &scope)
}

/// 移除 MCP 服务器
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn mcp_remove_server(
    name: String,
    scope: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    let claude_path = get_claude_path(&state)?;
    let service = McpManagerService::new(claude_path);
    service.remove_server(&name, scope.as_deref())
}

/// 启动 MCP 服务器 OAuth 认证
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn mcp_start_auth(
    name: String,
    url: String,
    scope: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let claude_path = get_claude_path(&state)?;
    let service = McpManagerService::new(claude_path);
    service.start_auth(&name, &url, &scope)
}
