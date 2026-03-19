/*! Git Stash 操作
 *
 * 提供暂存区保存、列表、应用、删除等功能
 */

use std::path::Path;

use crate::models::git::{GitStashEntry, GitServiceError};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use super::utils::CREATE_NO_WINDOW;

/// 保存 Stash
pub fn stash_save(
    path: &Path,
    message: Option<&str>,
    include_untracked: bool,
) -> Result<String, GitServiceError> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("stash").arg("push");

    if let Some(msg) = message {
        cmd.arg("-m").arg(msg);
    }

    if include_untracked {
        cmd.arg("--include-untracked");
    }

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.current_dir(path).output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitServiceError::CLIError(stderr.to_string()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 获取 Stash 列表
pub fn stash_list(path: &Path) -> Result<Vec<GitStashEntry>, GitServiceError> {
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["stash", "list", "--format=%gd|%gs|%h|%ct"])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["stash", "list", "--format=%gd|%gs|%h|%ct"])
        .current_dir(path)
        .output()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() >= 4 {
            let index_str = parts[0]
                .trim_start_matches("stash@{")
                .trim_end_matches("}");
            entries.push(GitStashEntry {
                index: index_str.parse().unwrap_or(0),
                message: parts[1].to_string(),
                branch: String::new(),
                commit_sha: parts[2].to_string(),
                timestamp: parts[3].parse().unwrap_or(0),
            });
        }
    }

    Ok(entries)
}

/// 应用 Stash
pub fn stash_pop(path: &Path, index: Option<usize>) -> Result<(), GitServiceError> {
    let stash_ref = index
        .map(|i| format!("stash@{{{}}}", i))
        .unwrap_or_else(|| "stash@{0}".to_string());

    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["stash", "pop", &stash_ref])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["stash", "pop", &stash_ref])
        .current_dir(path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitServiceError::CLIError(stderr.to_string()));
    }

    Ok(())
}

/// 删除 Stash
pub fn stash_drop(path: &Path, index: usize) -> Result<(), GitServiceError> {
    let stash_ref = format!("stash@{{{}}}", index);

    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["stash", "drop", &stash_ref])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["stash", "drop", &stash_ref])
        .current_dir(path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitServiceError::CLIError(stderr.to_string()));
    }

    Ok(())
}
