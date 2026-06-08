//! 截图：xcap 抓屏 → 可选裁剪/降采样 → PNG → base64。
//!
//! 复用 xcap re-export 的 `image` crate（`xcap::image`），避免与单独引入的 image 版本冲突。
//! `region` 截取局部、`scale` 降采样，二者都能显著降低回传给模型的图像体积（token）。

use std::io::Cursor;

use base64::Engine;
use serde_json::{json, Value};
use xcap::image::imageops::{self, FilterType};
use xcap::{Monitor, Window};

use crate::error::{AppError, Result};

/// 截图结果：PNG 字节的 base64 编码 + 像素尺寸。
pub struct ScreenshotResult {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
}

/// 截取显示器。
/// - `monitor_index`：显示器序号，省略取第 0 个（通常主屏）。
/// - `region`：`(x, y, width, height)` 局部裁剪（相对该显示器图像，自动 clamp 到边界）。
/// - `scale`：`0<scale<1` 时按比例降采样（如 0.5 半尺寸），大幅减小体积。
pub fn screenshot(
    monitor_index: Option<usize>,
    region: Option<(u32, u32, u32, u32)>,
    scale: Option<f32>,
) -> Result<ScreenshotResult> {
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

    let full = monitor
        .capture_image()
        .map_err(|e| AppError::ProcessError(format!("截图失败: {e}")))?;

    // 1) 局部裁剪（clamp 到图像范围，避免越界 panic）
    let mut img = match region {
        Some((rx, ry, rw, rh)) => {
            let (iw, ih) = (full.width(), full.height());
            let x = rx.min(iw.saturating_sub(1));
            let y = ry.min(ih.saturating_sub(1));
            let w = rw.min(iw - x).max(1);
            let h = rh.min(ih - y).max(1);
            imageops::crop_imm(&full, x, y, w, h).to_image()
        }
        None => full,
    };

    // 2) 降采样（仅缩小，scale 超出 (0,1) 忽略）
    if let Some(s) = scale {
        if s > 0.0 && s < 1.0 {
            let nw = ((img.width() as f32) * s).round().max(1.0) as u32;
            let nh = ((img.height() as f32) * s).round().max(1.0) as u32;
            img = imageops::resize(&img, nw, nh, FilterType::Triangle);
        }
    }

    let width = img.width();
    let height = img.height();

    let mut buffer = Cursor::new(Vec::new());
    img.write_to(&mut buffer, xcap::image::ImageFormat::Png)
        .map_err(|e| AppError::ProcessError(format!("PNG 编码失败: {e}")))?;

    let png_base64 = base64::engine::general_purpose::STANDARD.encode(buffer.into_inner());

    Ok(ScreenshotResult {
        png_base64,
        width,
        height,
    })
}

/// 枚举当前可见的顶层窗口（标题/应用/位置/状态），跳过无标题窗口（噪声）。
pub fn list_windows() -> Result<Value> {
    let windows = Window::all().map_err(|e| AppError::ProcessError(format!("枚举窗口失败: {e}")))?;
    let mut list = Vec::new();
    for w in &windows {
        let title = w.title().unwrap_or_default();
        if title.trim().is_empty() {
            continue;
        }
        list.push(json!({
            "title": title,
            "app": w.app_name().unwrap_or_default(),
            "pid": w.pid().unwrap_or(0),
            "x": w.x().unwrap_or(0),
            "y": w.y().unwrap_or(0),
            "width": w.width().unwrap_or(0),
            "height": w.height().unwrap_or(0),
            "focused": w.is_focused().unwrap_or(false),
            "minimized": w.is_minimized().unwrap_or(false),
        }));
    }
    let count = list.len();
    Ok(json!({ "count": count, "windows": list }))
}
