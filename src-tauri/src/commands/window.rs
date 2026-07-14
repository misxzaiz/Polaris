#[cfg(feature = "tauri-app")]
use tauri::{AppHandle, Manager};

/// 切换 DevTools（F12 快捷键调用）
///
/// Tauri v2 说明：
/// - DevTools 方法在 WebviewWindow 上（内部委托给 Webview）
/// - 需要使用 `app.get_webview_window()` 获取 WebviewWindow
/// - release 构建需要在 Cargo.toml 中启用 `devtools` feature：
///   tauri = { version = "2.0", features = ["devtools"] }
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn toggle_devtools(app: AppHandle, window_label: Option<String>) -> Result<(), String> {
    let label = window_label.unwrap_or_else(|| "main".to_string());

    if let Some(window) = app.get_webview_window(&label) {
        // 检查 DevTools 是否已打开
        if window.is_devtools_open() {
            window.close_devtools();
        } else {
            window.open_devtools();
        }
        Ok(())
    } else {
        Err(format!("窗口 {} 不存在", label))
    }
}

/// 设置窗口始终置顶
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn set_always_on_top(app: AppHandle, always_on_top: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_always_on_top(always_on_top)
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("主窗口不存在".to_string())
    }
}

/// 获取窗口是否始终置顶
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn is_always_on_top(app: AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("main") {
        window.is_always_on_top().map_err(|e| e.to_string())
    } else {
        Err("主窗口不存在".to_string())
    }
}
