/// Pocket 文档生成 Rust 端
///
/// 文档生成主要在前端用 JS 库（docx/pptxgenjs）完成，Rust 端只负责：
/// 1. base64 解码
/// 2. 写入应用私有目录（app_data_dir）
/// 3. 返回文件路径（前端可触发系统分享）
///
/// 复用 `pocket_tools.rs` 的路径穿越防护逻辑。

use std::fs;
use std::path::PathBuf;
use tauri::Manager;
use base64::Engine;

/// 将相对路径解析到 Tauri 应用私有数据目录，防止路径穿越。
fn resolve_app_path(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if path.is_empty() {
        return Ok(base);
    }
    if path.starts_with('/') || path.starts_with("..") {
        return Err(format!("路径不安全：\"{}\"。文件操作限制在应用私有目录内。", path));
    }
    Ok(base.join(path))
}

/// 将 base64 编码的文件内容解码并写入应用私有目录，返回文件路径。
#[tauri::command]
pub fn document_download(
    app: tauri::AppHandle,
    filename: String,
    content_base64: String,
) -> Result<String, String> {
    #[cfg(mobile)]
    {
        use std::fs;
        let dir = resolve_app_path(&app, "documents")?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file_path = dir.join(&filename);
        let content = base64::engine::general_purpose::STANDARD
            .decode(&content_base64)
            .map_err(|e| format!("base64 解码失败：{}", e))?;
        fs::write(&file_path, &content).map_err(|e| e.to_string())?;
        Ok(format!("文件已保存：{}", file_path.display()))
    }
    #[cfg(not(mobile))]
    {
        // Phase 2 stub：验证路径解析逻辑，不实际解码
        let dir = resolve_app_path(&app, "documents")?;
        drop(dir);
        let _ = &content_base64;
        Ok(format!("document_download stub（仅移动端可用）：filename={}", filename))
    }
}

#[tauri::command]
pub fn document_download_probe() -> Result<(), String> {
    Ok(())
}