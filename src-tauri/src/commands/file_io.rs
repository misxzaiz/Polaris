//! 通用文件 IO Tauri Commands（自 commands/git.rs 迁出 —— git 面板 vNext PR-2b）
//!
//! 背景：`write_file_absolute` / `read_file_absolute` / `test_param_serialization`
//! 与 git 域无业务关联（仅文件 IO 与参数序列化自检），却寄居在 git 命令模块里挡住
//! 了「命令层 git 域整域摘除」。本文件是它们的新家：
//! - `write_file_absolute` / `read_file_absolute`：AI 撤销链的兜底读写通道，
//!   业务签名不变。
//! - `test_param_serialization`：契约测试面板的参数序列化自检命令。
//!
//! 注意：函数体（含错误整形）从旧模块逐字搬运，行为等价。

#![allow(non_snake_case)]
use crate::models::git::GitError;

/// 写入文件内容（用于撤销 AI 修改）
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn write_file_absolute(path: String, content: String) -> Result<(), GitError> {
    use std::path::Path;

    let file_path = Path::new(&path);

    // 确保父目录存在
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| GitError {
                code: "IO_ERROR".to_string(),
                message: format!("Failed to create directory: {}", e),
                details: None,
            })?;
        }
    }

    // 写入文件
    std::fs::write(file_path, content).map_err(|e| GitError {
        code: "IO_ERROR".to_string(),
        message: format!("Failed to write file: {}", e),
        details: None,
    })?;

    Ok(())
}

/// 读取文件内容（用于检查文件是否被修改）
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn read_file_absolute(path: String) -> Result<String, GitError> {
    use std::path::Path;

    let file_path = Path::new(&path);

    if !file_path.exists() {
        return Err(GitError {
            code: "FILE_NOT_FOUND".to_string(),
            message: format!("File does not exist: {}", path),
            details: None,
        });
    }

    std::fs::read_to_string(file_path).map_err(|e| GitError {
        code: "IO_ERROR".to_string(),
        message: format!("Failed to read file: {}", e),
        details: None,
    })
}

/// 测试命令 - 验证参数序列化
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn test_param_serialization(test_param: String) -> String {
    eprintln!("[Test Command] 接收到参数: {}", test_param);
    format!("收到参数: {}", test_param)
}
