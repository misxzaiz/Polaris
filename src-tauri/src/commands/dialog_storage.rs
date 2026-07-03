//! 历史对话存储 Tauri 命令
//!
//! 把对话从浏览器 OPFS 搬到磁盘 jsonl，统一接管在 `<DataRoot>/dialogs/` 下。
//!
//! 文件命名：`<externalId>.jsonl`（externalId 由前端清洗为 `[a-zA-Z0-9._-]+`）。
//! 写入策略：原子写入（`*.jsonl.tmp` → rename），避免崩溃时半截 jsonl。

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use serde::Serialize;

use crate::error::{AppError, Result};
use crate::services::data_root::data_root;

const DIALOG_FILE_EXT: &str = ".jsonl";
const MAX_NAME_LEN: usize = 255;

/// 列表 meta 条目：文件名 + 该文件首行(DialogMeta JSON 字符串)。
/// 仅读首行 → 会话列表无需把整份 jsonl(可能数 MB)读进内存/走 IPC。
#[derive(Serialize)]
pub struct DialogMetaEntry {
    pub name: String,
    #[serde(rename = "metaLine")]
    pub meta_line: String,
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > MAX_NAME_LEN {
        return Err(AppError::ValidationError(format!(
            "对话文件名长度非法: {} 字节",
            name.len()
        )));
    }
    if !name.ends_with(DIALOG_FILE_EXT) {
        return Err(AppError::ValidationError(format!(
            "对话文件名必须以 {} 结尾",
            DIALOG_FILE_EXT
        )));
    }
    let stem = name.trim_end_matches(DIALOG_FILE_EXT);
    if stem.is_empty() {
        return Err(AppError::ValidationError(
            "对话文件名 stem 为空".to_string(),
        ));
    }
    if !stem
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err(AppError::ValidationError(
            "对话文件名仅允许 [a-zA-Z0-9._-]".to_string(),
        ));
    }
    // 防 path traversal
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err(AppError::ValidationError(
            "对话文件名禁止路径分隔符".to_string(),
        ));
    }
    Ok(())
}

fn dialogs_dir() -> Result<PathBuf> {
    let dir = data_root().dialogs_dir();
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn dialog_path(name: &str) -> Result<PathBuf> {
    validate_name(name)?;
    Ok(dialogs_dir()?.join(name))
}

// ============================================================================
// inner 实现（共享给 IPC dispatch）
// ============================================================================

pub fn dialog_list_inner() -> Result<Vec<String>> {
    let dir = dialogs_dir()?;
    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            if let Some(name) = e.file_name().to_str() {
                if name.ends_with(DIALOG_FILE_EXT) {
                    names.push(name.to_string());
                }
            }
        }
    }
    Ok(names)
}

pub fn dialog_read_inner(name: &str) -> Result<Option<String>> {
    let p = dialog_path(name)?;
    if !p.exists() {
        return Ok(None);
    }
    Ok(Some(fs::read_to_string(&p)?))
}

/// 高效列举:仅读取每个 jsonl 文件的**首行**(DialogMeta),不加载消息体。
/// 会话越大收益越明显(几十 MB 的历史文件只读几百字节)。
pub fn dialog_list_meta_inner() -> Result<Vec<DialogMetaEntry>> {
    let dir = dialogs_dir()?;
    let mut out: Vec<DialogMetaEntry> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = match e.file_name().to_str() {
                Some(n) if n.ends_with(DIALOG_FILE_EXT) => n.to_string(),
                _ => continue,
            };
            let file = match fs::File::open(e.path()) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let mut reader = BufReader::new(file);
            let mut first_line = String::new();
            match reader.read_line(&mut first_line) {
                Ok(0) => continue, // 空文件
                Ok(_) => {
                    let trimmed = first_line.trim_end_matches(['\n', '\r']).to_string();
                    if !trimmed.is_empty() {
                        out.push(DialogMetaEntry {
                            name,
                            meta_line: trimmed,
                        });
                    }
                }
                Err(_) => continue,
            }
        }
    }
    Ok(out)
}

pub fn dialog_write_inner(name: &str, content: &str) -> Result<()> {
    let target = dialog_path(name)?;
    let parent = target
        .parent()
        .ok_or_else(|| AppError::ConfigError("无法解析对话目录".to_string()))?;
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!("{}.tmp", name));
    fs::write(&tmp, content)?;
    if target.exists() {
        fs::remove_file(&target)?;
    }
    fs::rename(&tmp, &target)?;
    Ok(())
}

pub fn dialog_delete_inner(name: &str) -> Result<()> {
    let p = dialog_path(name)?;
    if p.exists() {
        fs::remove_file(&p)?;
    }
    Ok(())
}

// ============================================================================
// Tauri 命令
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dialog_list() -> Result<Vec<String>> {
    dialog_list_inner()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dialog_list_meta() -> Result<Vec<DialogMetaEntry>> {
    dialog_list_meta_inner()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dialog_read(name: String) -> Result<Option<String>> {
    dialog_read_inner(&name)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dialog_write(name: String, content: String) -> Result<()> {
    dialog_write_inner(&name, &content)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dialog_delete(name: String) -> Result<()> {
    dialog_delete_inner(&name)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_name_ok() {
        assert!(validate_name("abc-123_def.jsonl").is_ok());
        assert!(validate_name("session.uuid.jsonl").is_ok());
    }

    #[test]
    fn test_validate_name_rejects_traversal() {
        assert!(validate_name("../etc/passwd.jsonl").is_err());
        assert!(validate_name("a/b.jsonl").is_err());
        assert!(validate_name("a\\b.jsonl").is_err());
    }

    #[test]
    fn test_validate_name_rejects_bad_ext() {
        assert!(validate_name("abc.txt").is_err());
        assert!(validate_name("abc").is_err());
        assert!(validate_name(".jsonl").is_err());
    }

    #[test]
    fn test_validate_name_rejects_special_chars() {
        assert!(validate_name("abc!.jsonl").is_err());
        assert!(validate_name("中文.jsonl").is_err());
        assert!(validate_name("ab cd.jsonl").is_err());
    }

    #[test]
    fn test_dialog_path_includes_dialogs_dir() {
        // 仅检查不 panic 与扩展名
        let p = dialog_path("test-session-1.jsonl").unwrap();
        assert!(p.to_string_lossy().contains("dialogs"));
        assert!(p.to_string_lossy().ends_with("test-session-1.jsonl"));
    }

    #[test]
    fn test_atomic_write_helper_validates_path() {
        // 非法名字应在 path 阶段就拒绝
        assert!(dialog_path("bad/../name.jsonl").is_err());
    }
}
