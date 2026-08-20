use crate::error::{AppError, Result};
use std::path::Path;

/// 获取用户主目录
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn get_home_dir() -> Result<String> {
    dirs::home_dir()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
        .ok_or_else(|| AppError::ConfigError("无法获取用户主目录".to_string()))
}

/// 验证工作区路径
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn validate_workspace_path(path: String) -> Result<bool> {
    let path_obj = Path::new(&path);
    
    // 检查路径是否存在且是目录
    if !path_obj.exists() {
        return Ok(false);
    }
    
    if !path_obj.is_dir() {
        return Ok(false);
    }
    
    // 检查是否包含 Git 仓库（可选，但推荐）
    let git_path = path_obj.join(".git");
    let _has_git = git_path.exists();
    
    // 如果有 Git 仓库，优先返回 true
    // 如果没有 Git 仓库，也返回 true（允许非 Git 项目）
    Ok(true)
}

/// 获取目录信息
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn get_directory_info(path: String) -> Result<DirectoryInfo> {
    let path_obj = Path::new(&path);
    
    if !path_obj.exists() || !path_obj.is_dir() {
        return Err(AppError::InvalidPath("路径不存在或不是目录".to_string()));
    }
    
    let name = path_obj
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();
    
    let has_git = path_obj.join(".git").exists();
    
    Ok(DirectoryInfo {
        name,
        path,
        has_git,
    })
}

/// 目录信息结构
#[derive(serde::Serialize)]
pub struct DirectoryInfo {
    pub name: String,
    pub path: String,
    pub has_git: bool,
}