//! 截图：xcap 抓屏 → PNG → base64。
//!
//! 复用 xcap re-export 的 `image` crate（`xcap::image`），避免与单独引入的 image 版本冲突。

use std::io::Cursor;

use base64::Engine;
use xcap::Monitor;

use crate::error::{AppError, Result};

/// 截图结果：PNG 字节的 base64 编码 + 像素尺寸。
pub struct ScreenshotResult {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
}

/// 截取显示器。`monitor_index` 省略时取第 0 个（通常为主显示器）。
pub fn screenshot(monitor_index: Option<usize>) -> Result<ScreenshotResult> {
    let monitors =
        Monitor::all().map_err(|e| AppError::ProcessError(format!("枚举显示器失败: {e}")))?;
    if monitors.is_empty() {
        return Err(AppError::ProcessError("未检测到显示器".to_string()));
    }

    let index = monitor_index.unwrap_or(0);
    let monitor = monitors.get(index).ok_or_else(|| {
        AppError::ValidationError(format!(
            "显示器索引越界: {index}（共检测到 {} 个）",
            monitors.len()
        ))
    })?;

    let image = monitor
        .capture_image()
        .map_err(|e| AppError::ProcessError(format!("截图失败: {e}")))?;
    let width = image.width();
    let height = image.height();

    let mut buffer = Cursor::new(Vec::new());
    image
        .write_to(&mut buffer, xcap::image::ImageFormat::Png)
        .map_err(|e| AppError::ProcessError(format!("PNG 编码失败: {e}")))?;

    let png_base64 = base64::engine::general_purpose::STANDARD.encode(buffer.into_inner());

    Ok(ScreenshotResult {
        png_base64,
        width,
        height,
    })
}
