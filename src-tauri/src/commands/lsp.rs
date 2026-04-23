/*! LSP 语言服务器 Tauri 命令
 *
 * 三个命令覆盖完整生命周期：
 * - lsp_start:  启动语言服务器进程
 * - lsp_send:   发送 JSON-RPC 消息
 * - lsp_stop:   停止语言服务器
 */

use tauri::{AppHandle, State};

use crate::error::Result;
use crate::AppState;

/// 启动语言服务器进程
#[tauri::command]
pub fn lsp_start(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    id: String,
    command: String,
    args: Vec<String>,
) -> Result<()> {
    let mut manager = state
        .lsp_manager
        .lock()
        .map_err(|e| crate::error::AppError::StateError(e.to_string()))?;
    manager.start(id, &command, &args, app_handle)
}

/// 发送 JSON-RPC 消息到语言服务器
#[tauri::command]
pub fn lsp_send(state: State<'_, AppState>, id: String, data: String) -> Result<()> {
    let mut manager = state
        .lsp_manager
        .lock()
        .map_err(|e| crate::error::AppError::StateError(e.to_string()))?;
    manager.send(&id, &data)
}

/// 停止语言服务器
#[tauri::command]
pub fn lsp_stop(state: State<'_, AppState>, id: String) -> Result<()> {
    let mut manager = state
        .lsp_manager
        .lock()
        .map_err(|e| crate::error::AppError::StateError(e.to_string()))?;
    manager.stop(&id)
}

/// 列出所有活跃的 LSP 会话
#[tauri::command]
pub fn lsp_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>> {
    let manager = state
        .lsp_manager
        .lock()
        .map_err(|e| crate::error::AppError::StateError(e.to_string()))?;
    Ok(manager.list_sessions())
}
