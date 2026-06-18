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

use crate::services::lsp_index::{DirtyBuffer, IndexMatch, IndexStatus};

/// 索引模式：在工作区查找符号的全部引用（查应用）。
///
/// `live_overrides` 是前端传入的未保存修改；同 path 的 DB 数据会被替换。
/// 当前文件 `current_file` 给排序层用（确定 import / package 上下文）。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_index_references(
    state: State<'_, AppState>,
    root: String,
    symbol: String,
    extensions: Vec<String>,
    current_file: Option<String>,
    live_overrides: Option<Vec<DirtyBuffer>>,
) -> Result<Vec<IndexMatch>> {
    let _ = current_file;
    let svc = state.lsp_index_service.clone();
    let workspace = std::path::Path::new(&root);
    let _ = svc.open_workspace(workspace);

    let status = svc.status(workspace);
    if status.files > 0 {
        let dirty = live_overrides.unwrap_or_default();
        return svc.find_references(workspace, &symbol, 5000, &dirty);
    }
    crate::services::lsp_index::find_references(&root, &symbol, &extensions)
}

/// 索引模式：在工作区查找符号的定义候选（跳转定义）。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_index_definition(
    state: State<'_, AppState>,
    root: String,
    symbol: String,
    language: String,
    extensions: Vec<String>,
    current_file: Option<String>,
    live_overrides: Option<Vec<DirtyBuffer>>,
) -> Result<Vec<IndexMatch>> {
    let svc = state.lsp_index_service.clone();
    let workspace = std::path::Path::new(&root);
    let _ = svc.open_workspace(workspace);

    let status = svc.status(workspace);
    if status.files > 0 {
        let dirty = live_overrides.unwrap_or_default();
        return svc.find_definition(workspace, &symbol, current_file.as_deref(), &dirty);
    }
    crate::services::lsp_index::find_definition(&root, &symbol, &language, &extensions)
}

/// 索引模式：打开工作区的索引引擎（创建/重用 DB）。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_index_open(
    state: State<'_, AppState>,
    root: String,
) -> Result<IndexStatus> {
    let svc = state.lsp_index_service.clone();
    let workspace = std::path::Path::new(&root);
    let _ = svc.open_workspace(workspace)?;
    Ok(svc.status(workspace))
}

/// 索引模式：关闭工作区索引（释放 DB 句柄）。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_index_close(
    state: State<'_, AppState>,
    root: String,
) -> Result<()> {
    let svc = state.lsp_index_service.clone();
    let workspace = std::path::Path::new(&root);
    svc.close_workspace(workspace);
    Ok(())
}

/// 索引模式：触发后台全量重建。立即返回，进度通过事件推送。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_index_rebuild(
    state: State<'_, AppState>,
    root: String,
) -> Result<()> {
    let svc = state.lsp_index_service.clone();
    let workspace = std::path::Path::new(&root);
    svc.rebuild_full_async(workspace)
}

/// 索引模式：查询当前状态。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_index_status(
    state: State<'_, AppState>,
    root: String,
) -> Result<IndexStatus> {
    let svc = state.lsp_index_service.clone();
    let workspace = std::path::Path::new(&root);
    Ok(svc.status(workspace))
}

/// 索引模式：单文件增量更新（前端保存文件后调用）。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn lsp_index_update_file(
    state: State<'_, AppState>,
    root: String,
    abs_path: String,
) -> Result<()> {
    let svc = state.lsp_index_service.clone();
    let workspace = std::path::Path::new(&root);
    let abs = std::path::Path::new(&abs_path);
    svc.update_file(workspace, abs)
}
