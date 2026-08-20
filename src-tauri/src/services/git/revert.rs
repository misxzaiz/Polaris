/*! Git Revert 操作
 *
 * 提交回滚、中止、继续等功能
 */

use std::path::Path;
use tracing::info;

use crate::models::git::{GitRevertResult, GitServiceError};
use super::executor::open_repository;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use super::utils::CREATE_NO_WINDOW;

/// Revert 提交
pub fn revert(path: &Path, commit_sha: &str) -> Result<GitRevertResult, GitServiceError> {
    info!("开始 revert 操作: {}", commit_sha);

    let repo = open_repository(path)?;

    // 检查是否有正在进行的 revert
    let revert_state_path = path.join(".git").join("REVERT_HEAD");
    if revert_state_path.exists() {
        return Err(GitServiceError::RevertInProgress);
    }

    // 检查是否有正在进行的合并
    if repo.index()?.has_conflicts() {
        return Err(GitServiceError::MergeInProgress);
    }

    // 执行 revert 操作
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["revert", commit_sha, "--no-edit"])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["revert", commit_sha, "--no-edit"])
        .current_dir(path)
        .output()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if output.status.success() {
        info!("Revert 成功完成");

        let new_commit_sha = repo
            .head()?
            .target()
            .map(|oid| oid.to_string())
            .unwrap_or_default();

        let commit_message = if let Ok(head) = repo.head() {
            if let Ok(commit) = head.peel_to_commit() {
                commit.message().unwrap_or("").to_string()
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        Ok(GitRevertResult {
            success: true,
            has_conflicts: false,
            conflicts: vec![],
            commit_sha: new_commit_sha,
            commit_message,
            finished: true,
        })
    } else {
        let has_conflicts = stderr.contains("CONFLICT")
            || stderr.contains("conflict")
            || stdout.contains("CONFLICT");

        let conflicts = if has_conflicts {
            get_conflict_files(path)?
        } else {
            vec![]
        };

        if has_conflicts {
            info!("Revert 遇到冲突: {} 个文件", conflicts.len());
            Ok(GitRevertResult {
                success: false,
                has_conflicts: true,
                conflicts,
                commit_sha: commit_sha.to_string(),
                commit_message: String::new(),
                finished: false,
            })
        } else {
            Err(GitServiceError::CLIError(stderr.to_string()))
        }
    }
}

/// 中止 Revert 操作
pub fn revert_abort(path: &Path) -> Result<(), GitServiceError> {
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["revert", "--abort"])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["revert", "--abort"])
        .current_dir(path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitServiceError::CLIError(stderr.to_string()));
    }

    Ok(())
}

/// 继续 Revert 操作
pub fn revert_continue(path: &Path) -> Result<GitRevertResult, GitServiceError> {
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["revert", "--continue", "--no-edit"])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["revert", "--continue", "--no-edit"])
        .current_dir(path)
        .output()?;

    let _stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if output.status.success() {
        let repo = open_repository(path)?;
        let new_commit_sha = repo
            .head()?
            .target()
            .map(|oid| oid.to_string())
            .unwrap_or_default();

        let commit_message = if let Ok(head) = repo.head() {
            if let Ok(commit) = head.peel_to_commit() {
                commit.message().unwrap_or("").to_string()
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        Ok(GitRevertResult {
            success: true,
            has_conflicts: false,
            conflicts: vec![],
            commit_sha: new_commit_sha,
            commit_message,
            finished: true,
        })
    } else {
        let has_conflicts = stderr.contains("CONFLICT") || stderr.contains("conflict");

        let conflicts = if has_conflicts { get_conflict_files(path)? } else { vec![] };

        if has_conflicts {
            Ok(GitRevertResult {
                success: false,
                has_conflicts: true,
                conflicts,
                commit_sha: String::new(),
                commit_message: String::new(),
                finished: false,
            })
        } else {
            Err(GitServiceError::CLIError(stderr.to_string()))
        }
    }
}

/// 获取冲突文件列表
fn get_conflict_files(path: &Path) -> Result<Vec<String>, GitServiceError> {
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(path)
        .output()?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect())
    } else {
        Ok(vec![])
    }
}
