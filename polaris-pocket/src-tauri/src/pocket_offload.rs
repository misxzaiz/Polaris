/// Pocket Offload 统一入口
///
/// 提供日历、无障碍、视觉拍照等 Offload 命令，通过 JNI 桥接 Android 原生 API。
/// Phase 3 收紧：`#[cfg(not(mobile))]` 分支返回 `Err("仅移动端可用")`。
///
/// 注意：`pocket_tools.rs` 中的 `send_sms`/`get_contacts`/`scan_barcode`/`authenticate_biometric`
/// 已有 JNI 占位，本模块新增的 Offload 命令使用 `offload_` 前缀区分。

use serde::Deserialize;

// ============================================================================
// 日历
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct CalendarCreateRequest {
    pub title: String,
    pub start: String, // ISO 8601
    pub end: String,   // ISO 8601
    pub location: Option<String>,
}

/// 创建日历事件
#[tauri::command]
pub fn offload_calendar_create(
    _app: tauri::AppHandle,
    _req: CalendarCreateRequest,
) -> Result<String, String> {
    #[cfg(mobile)]
    {
        // JNI 调用 PocketCalendarBridge.createEvent（Phase 3 实现）
        // 参考 @tauri-apps/plugin-haptics 的 Android JNI 模板
        Ok("日历事件已创建（JNI 待实现：CalendarBridge.kt）".to_string())
    }
    #[cfg(not(mobile))]
    {
        Err("仅移动端可用".to_string())
    }
}

#[tauri::command]
pub fn offload_calendar_create_probe() -> Result<(), String> {
    #[cfg(mobile)]
    {
        Ok(())
    }
    #[cfg(not(mobile))]
    {
        Err("仅移动端可用".to_string())
    }
}

// ============================================================================
// 无障碍 UI 树
// ============================================================================

/// 获取当前屏幕 UI 树（JSON 格式）
#[tauri::command]
pub fn offload_accessibility_ui_tree() -> Result<String, String> {
    #[cfg(mobile)]
    {
        // JNI 调用 PocketAccessibilityBridge.getUiThread()（Phase 3 实现）
        Ok("{}".to_string())
    }
    #[cfg(not(mobile))]
    {
        Err("仅移动端可用".to_string())
    }
}

#[tauri::command]
pub fn offload_accessibility_ui_tree_probe() -> Result<(), String> {
    #[cfg(mobile)]
    {
        Ok(())
    }
    #[cfg(not(mobile))]
    {
        Err("仅移动端可用".to_string())
    }
}

/// 在指定坐标模拟点击（无障碍手势）
#[tauri::command]
pub fn offload_accessibility_click(x: f64, y: f64) -> Result<String, String> {
    #[cfg(mobile)]
    {
        // JNI 调用 PocketAccessibilityBridge.clickAt(x, y)（Phase 3 实现）
        Ok(format!("已点击 ({}, {})（JNI 待实现：AccessibilityBridge.kt）", x, y))
    }
    #[cfg(not(mobile))]
    {
        Err("仅移动端可用".to_string())
    }
}

#[tauri::command]
pub fn offload_accessibility_click_probe() -> Result<(), String> {
    #[cfg(mobile)]
    {
        Ok(())
    }
    #[cfg(not(mobile))]
    {
        Err("仅移动端可用".to_string())
    }
}

// ============================================================================
// 视觉拍照
// ============================================================================

/// 调用相机拍照，返回 base64 图片
#[tauri::command]
pub fn offload_vision_capture() -> Result<String, String> {
    #[cfg(mobile)]
    {
        // JNI 调用 PocketVisionBridge.takePhoto()（Phase 3 实现）
        // 或确认 @tauri-apps/plugin-camera 可用性后改用插件
        Ok("拍照功能待实现（JNI 待实现：VisionBridge.kt 或确认 plugin-camera）".to_string())
    }
    #[cfg(not(mobile))]
    {
        Err("仅移动端可用".to_string())
    }
}

#[tauri::command]
pub fn offload_vision_capture_probe() -> Result<(), String> {
    #[cfg(mobile)]
    {
        Ok(())
    }
    #[cfg(not(mobile))]
    {
        Err("仅移动端可用".to_string())
    }
}