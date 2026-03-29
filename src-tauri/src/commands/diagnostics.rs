use std::path::PathBuf;

use tauri::{Manager, Window};

use crate::error::{AppError, Result};
use crate::services::mcp_diagnostics_service::{TodoMcpDiagnostics, TodoMcpDiagnosticsService};

#[tauri::command]
pub fn get_todo_mcp_diagnostics(window: Window, workspace_path: Option<String>) -> Result<TodoMcpDiagnostics> {
    let app_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| AppError::ProcessError("无法确定应用根目录".to_string()))?
        .to_path_buf();
    let resource_dir = window.path().resource_dir().ok();
    let config_dir = window.path().app_config_dir()
        .map_err(|e| AppError::ProcessError(format!("获取配置目录失败: {}", e)))?;

    TodoMcpDiagnosticsService::collect(config_dir, app_root, resource_dir, workspace_path.as_deref())
}
