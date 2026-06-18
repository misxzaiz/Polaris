/*! LSP 语言服务器 Tauri 命令
 *
 * 进程管理命令：start/send/stop/list_sessions
 * 配置管理命令：config_list/config_upsert/config_remove/config_toggle
 */

#[cfg(feature = "tauri-app")]
use tauri::{AppHandle, State};

use crate::error::Result;
use crate::services::lsp_config_repository::LspServerEntry;
use crate::AppState;

// ── 进程管理 ──────────────────────────────────────

/// 启动语言服务器进程
#[cfg(feature = "tauri-app")]
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
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_send(state: State<'_, AppState>, id: String, data: String) -> Result<()> {
    let mut manager = state
        .lsp_manager
        .lock()
        .map_err(|e| crate::error::AppError::StateError(e.to_string()))?;
    manager.send(&id, &data)
}

/// 停止语言服务器
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_stop(state: State<'_, AppState>, id: String) -> Result<()> {
    let mut manager = state
        .lsp_manager
        .lock()
        .map_err(|e| crate::error::AppError::StateError(e.to_string()))?;
    manager.stop(&id)
}

/// 列出所有活跃的 LSP 会话
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>> {
    let manager = state
        .lsp_manager
        .lock()
        .map_err(|e| crate::error::AppError::StateError(e.to_string()))?;
    Ok(manager.list_sessions())
}

// ── 配置管理 ──────────────────────────────────────

/// 读取所有 LSP 服务器配置
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_config_list(state: State<'_, AppState>) -> Result<Vec<LspServerEntry>> {
    let repo = state
        .lsp_config
        .lock()
        .map_err(|e| crate::error::AppError::StateError(e.to_string()))?;
    Ok(repo.list().to_vec())
}

/// 添加或更新 LSP 服务器配置
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_config_upsert(state: State<'_, AppState>, entry: LspServerEntry) -> Result<()> {
    let mut repo = state
        .lsp_config
        .lock()
        .map_err(|e| crate::error::AppError::StateError(e.to_string()))?;
    repo.upsert(entry)
}

/// 删除 LSP 服务器配置
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_config_remove(state: State<'_, AppState>, id: String) -> Result<()> {
    let mut repo = state
        .lsp_config
        .lock()
        .map_err(|e| crate::error::AppError::StateError(e.to_string()))?;
    repo.remove(&id)
}

/// 切换 LSP 服务器启用/禁用
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_config_toggle(state: State<'_, AppState>, id: String, enabled: bool) -> Result<()> {
    let mut repo = state
        .lsp_config
        .lock()
        .map_err(|e| crate::error::AppError::StateError(e.to_string()))?;
    repo.set_enabled(&id, enabled)
}

// ── 命令校验 ──────────────────────────────────────

/// 命令存在性校验结果
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCommandCheck {
    /// 是否在 PATH 中找到
    pub found: bool,
    /// 解析到的完整路径（找到时）
    pub resolved_path: Option<String>,
}

/// 校验语言服务器可执行文件是否存在（设置页"添加服务器"时调用）。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_check_command(command: String) -> Result<LspCommandCheck> {
    let resolved = crate::services::lsp::which_command(&command);
    Ok(LspCommandCheck {
        found: resolved.is_some(),
        resolved_path: resolved,
    })
}

// ── 轻量索引模式（无常驻进程）─────────────────────

/// 索引模式：在工作区查找符号的全部引用（查应用）。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_index_references(
    root: String,
    symbol: String,
    extensions: Vec<String>,
) -> Result<Vec<crate::services::lsp_index::IndexMatch>> {
    crate::services::lsp_index::find_references(&root, &symbol, &extensions)
}

/// 索引模式：在工作区查找符号的定义候选（跳转定义）。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_index_definition(
    root: String,
    symbol: String,
    language: String,
    extensions: Vec<String>,
) -> Result<Vec<crate::services::lsp_index::IndexMatch>> {
    crate::services::lsp_index::find_definition(&root, &symbol, &language, &extensions)
}
