//! 数据根（DataRoot）平台壳命令
//!
//! 管理面业务已上总线（`cap.data_root`，见 `services/router/data_root_capability.rs`），
//! 本文件仅保留**平台壳命令** `open_path_in_explorer`——按 step7 §3 边界，
//! 资源管理器打开路径属平台集成（非业务域），不进总线。
//!
//! 已移除（迁入 capability）：get_data_root_info / scan_legacy_data /
//! migrate_legacy_data / validate_data_root_target / set_data_root。

use std::path::PathBuf;

use crate::error::{AppError, Result};

/// 在系统资源管理器中打开路径
pub fn open_path_in_explorer_inner(path: PathBuf) -> Result<()> {
    if !path.exists() {
        return Err(AppError::InvalidPath(format!("路径不存在: {}", path.display())));
    }

    // tauri_plugin_opener 在 lib 里已初始化；这里直接走 OS 命令兜底，
    // 让 web 模式（无 Tauri runtime）也能用。
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer")
            .arg(&path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| AppError::IoError(e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::IoError(e))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::IoError(e))?;
    }
    Ok(())
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn open_path_in_explorer(path: String) -> Result<()> {
    open_path_in_explorer_inner(PathBuf::from(path))
}
