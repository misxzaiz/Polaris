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

    // C11 交叉守卫：任何序列操作进行中均拒绝（merge/rebase/cherry-pick/revert 互斥）
    super::sequence::guard_no_sequence(path)?;

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

    let _stdout = String::from_utf8_lossy(&output.stdout);
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
        // C11：冲突判定归一从序列状态回读，不信任 stderr 包含 "CONFLICT"
        let state = super::sequence::get_sequence_state(path)?;
        let has_conflicts = state.has_conflicts;

        if has_conflicts {
            info!("Revert 遇到冲突: {} 个文件", state.conflicts.len());
            Ok(GitRevertResult {
                success: false,
                has_conflicts: true,
                conflicts: state.conflicts,
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
        // C11：Continue 从状态回读，不信任 stderr 包含 "CONFLICT"
        let state = super::sequence::get_sequence_state(path)?;
        let has_conflicts = state.has_conflicts;

        if has_conflicts {
            Ok(GitRevertResult {
                success: false,
                has_conflicts: true,
                conflicts: state.conflicts,
                commit_sha: String::new(),
                commit_message: String::new(),
                finished: false,
            })
        } else {
            Err(GitServiceError::CLIError(stderr.to_string()))
        }
    }
}
