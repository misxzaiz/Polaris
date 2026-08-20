/*! 文件系统监听命令
 *
 * 代理到 services::file_watcher::FileWatcherManager
 * 受 performance.fileWatcher 开关控制
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
    // 检查性能开关
    let perf = {
        let store = state.config_store.lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;
        store.get().performance.file_watcher
    };
    if !perf {
        return Err(AppError::Unknown(
            "文件监听已禁用（performance.fileWatcher=false，请在设置中启用）".to_string()
        ));
    }

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
