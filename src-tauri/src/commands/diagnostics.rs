use std::path::PathBuf;

#[cfg(feature = "tauri-app")]
use tauri::Manager;

use crate::error::{AppError, Result};
use crate::services::mcp_diagnostics_service::{TodoMcpDiagnostics, TodoMcpDiagnosticsService};

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn get_todo_mcp_diagnostics(
    window: tauri::Window,
    workspace_path: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<TodoMcpDiagnostics> {
    let app_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| AppError::ProcessError("无法确定应用根目录".to_string()))?
        .to_path_buf();
    let resource_dir = window.path().resource_dir().ok();
    let config_dir = state.data_root.lock().unwrap().config_dir();

    TodoMcpDiagnosticsService::collect(config_dir, app_root, resource_dir, workspace_path.as_deref())
}
