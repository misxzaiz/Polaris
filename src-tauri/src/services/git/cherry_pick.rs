/*! Git Cherry-pick 操作
 *
 * 提供提交挑选、中止、继续等功能
 */

use std::path::Path;
use tracing::info;

use crate::models::git::{GitCherryPickResult, GitServiceError};
use super::executor::open_repository;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use super::utils::CREATE_NO_WINDOW;

/// Cherry-pick 提交
pub fn cherry_pick(path: &Path, commit_sha: &str) -> Result<GitCherryPickResult, GitServiceError> {
    info!("开始 cherry-pick 操作: {}", commit_sha);

    let repo = open_repository(path)?;

    // 检查是否有正在进行的 cherry-pick
    let cherry_pick_state_path = path.join(".git").join("CHERRY_PICK_HEAD");
    if cherry_pick_state_path.exists() {
        return Err(GitServiceError::CherryPickInProgress);
    }

    // 检查是否有正在进行的合并
    if repo.index()?.has_conflicts() {
        return Err(GitServiceError::MergeInProgress);
    }

    // 执行 cherry-pick 操作
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["cherry-pick", commit_sha])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["cherry-pick", commit_sha])
        .current_dir(path)
        .output()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if output.status.success() {
        info!("Cherry-pick 成功完成");

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

        Ok(GitCherryPickResult {
            success: true,
            has_conflicts: false,
            conflicts: vec![],
            commit_sha: new_commit_sha,
            commit_message,
            finished: true,
        })
    } else {
        let has_conflicts =
            stderr.contains("CONFLICT") || stderr.contains("conflict") || stdout.contains("CONFLICT");

        let conflicts = if has_conflicts {
            get_conflict_files(path)?
        } else {
            vec![]
        };

        if has_conflicts {
            info!("Cherry-pick 遇到冲突: {} 个文件", conflicts.len());
            Ok(GitCherryPickResult {
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

/// 中止 Cherry-pick 操作
pub fn cherry_pick_abort(path: &Path) -> Result<(), GitServiceError> {
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["cherry-pick", "--abort"])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["cherry-pick", "--abort"])
        .current_dir(path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitServiceError::CLIError(stderr.to_string()));
    }

    Ok(())
}

/// 继续 Cherry-pick 操作
pub fn cherry_pick_continue(path: &Path) -> Result<GitCherryPickResult, GitServiceError> {
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["cherry-pick", "--continue"])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["cherry-pick", "--continue"])
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

        Ok(GitCherryPickResult {
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
            Ok(GitCherryPickResult {
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
