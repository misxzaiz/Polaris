//! HTTP Client 持久化存储
//!
//! 请求集合与环境变量集合的磁盘读写。文件位于 `<DataRoot>/http-client/`：
//! - `collection.json`：保存的请求集合（用户命名的请求，含 spec）
//! - `environments.json`：环境变量集合
//!
//! 写入策略：原子写入（`.tmp` → rename），避免崩溃时半截 JSON。
//! 文件名白名单校验，防 path traversal。

use std::fs;
use std::path::PathBuf;

use crate::error::{AppError, Result};
use crate::services::data_root::data_root;

/// 允许读写的文件名白名单
const ALLOWED_FILES: &[&str] = &["collection.json", "environments.json"];

fn http_client_dir() -> Result<PathBuf> {
    let dir = data_root().http_client_dir();
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn resolve_path(name: &str) -> Result<PathBuf> {
    if !ALLOWED_FILES.contains(&name) {
        return Err(AppError::ValidationError(format!(
            "非法文件名: {}（仅允许 {:?}）",
            name, ALLOWED_FILES
        )));
    }
    // 防 path traversal
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err(AppError::ValidationError(
            "文件名禁止路径分隔符".to_string(),
        ));
    }
    Ok(http_client_dir()?.join(name))
}

/// 读取文件内容，文件不存在返回 None
pub fn read_file(name: &str) -> Result<Option<String>> {
    let path = resolve_path(name)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(fs::read_to_string(&path)?))
}

/// 原子写入文件
pub fn write_file(name: &str, content: &str) -> Result<()> {
    let target = resolve_path(name)?;
    let parent = target
        .parent()
        .ok_or_else(|| AppError::ConfigError("无法解析 http-client 目录".to_string()))?;
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!("{}.tmp", name));
    fs::write(&tmp, content)?;
    if target.exists() {
        fs::remove_file(&target)?;
    }
    fs::rename(&tmp, &target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_path_rejects_unknown() {
        assert!(resolve_path("secrets.json").is_err());
        assert!(resolve_path("collection.json").is_ok());
        assert!(resolve_path("environments.json").is_ok());
    }

    #[test]
    fn test_resolve_path_rejects_traversal() {
        assert!(resolve_path("../collection.json").is_err());
        assert!(resolve_path("a/b.json").is_err());
    }
}
