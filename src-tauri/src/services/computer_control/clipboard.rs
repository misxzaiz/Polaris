//! 剪贴板读写（Windows，基于 uiautomation 的 Clipboard）。
//!
//! 用途：`clipboard set` 后配合 `press_key ctrl+v` 粘贴大段文本，比 `type_text` 逐字符
//! 更快且避开输入法干扰；`clipboard get` 读取当前剪贴板内容。

use uiautomation::clipboards::Clipboard;

use crate::error::{AppError, Result};

pub fn get_text() -> Result<String> {
    let clipboard =
        Clipboard::open().map_err(|e| AppError::ProcessError(format!("打开剪贴板失败: {e}")))?;
    clipboard
        .get_text()
        .map_err(|e| AppError::ProcessError(format!("读取剪贴板失败: {e}")))
}

pub fn set_text(text: &str) -> Result<()> {
    let clipboard =
        Clipboard::open().map_err(|e| AppError::ProcessError(format!("打开剪贴板失败: {e}")))?;
    clipboard
        .set_text(text)
        .map_err(|e| AppError::ProcessError(format!("写入剪贴板失败: {e}")))
}
