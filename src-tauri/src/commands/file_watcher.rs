/*! 文件系统监听命令
 *
 * 代理到 services::file_watcher::FileWatcherManager
 */

use crate::error::{AppError, Result};
use crate::state::AppState;

/// 启动文件系统监听
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn fs_watch_start(
    root_path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<()> {
    let mut manager = state
        .file_watcher_manager
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    manager
        .start(root_path, app_handle)
        .map_err(AppError::Unknown)
}

/// 停止文件系统监听
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn fs_watch_stop(state: tauri::State<AppState>) -> Result<()> {
    let mut manager = state
        .file_watcher_manager
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    manager.stop();
    Ok(())
}

/// 获取文件监听状态
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn fs_watch_status(state: tauri::State<AppState>) -> bool {
    let manager = state
        .file_watcher_manager
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    manager.is_watching()
}
