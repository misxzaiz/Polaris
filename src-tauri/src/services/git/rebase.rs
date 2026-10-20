/*! Git Rebase 操作
 *
 * 提供分支变基、中止、继续等功能
 */

use std::path::Path;
use tracing::info;

use crate::models::git::{GitRebaseResult, GitServiceError};
use super::executor::open_repository;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use super::utils::CREATE_NO_WINDOW;

/// 变基分支
pub fn rebase_branch(path: &Path, source_branch: &str) -> Result<GitRebaseResult, GitServiceError> {
    info!("开始变基操作: 当前分支 -> {}", source_branch);

    let repo = open_repository(path)?;

    // 检查是否有正在进行的变基
    let rebase_state_path = path.join(".git").join("rebase-merge");
    if rebase_state_path.exists() {
        return Err(GitServiceError::RebaseInProgress);
    }

    // 检查是否有正在进行的合并
    if repo.index()?.has_conflicts() {
        return Err(GitServiceError::MergeInProgress);
    }

    // 获取当前分支
    let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .unwrap_or_else(|| "HEAD".to_string());

    // 不能变基到自身
    if current_branch == source_branch {
        return Err(GitServiceError::CLIError(format!(
            "Cannot rebase branch '{}' onto itself",
            source_branch
        )));
    }

    // 获取目标分支的 commit
    let target_ref = repo
        .find_branch(source_branch, git2::BranchType::Local)
        .or_else(|_| repo.find_branch(source_branch, git2::BranchType::Remote))?;

    let target_commit_oid = target_ref
        .get()
        .target()
        .ok_or_else(|| GitServiceError::BranchNotFound(source_branch.to_string()))?;

    // 获取当前 HEAD commit
    let head = repo.head()?;
    let head_commit = head.peel_to_commit()?;

    // 找到共同祖先
    let merge_base = repo.merge_base(head_commit.id(), target_commit_oid)?;

    // 如果当前分支已经是最新的，无需变基
    if merge_base == head_commit.id() {
        return Ok(GitRebaseResult {
            success: true,
            has_conflicts: false,
            conflicts: vec![],
            rebased_commits: 0,
            current_step: 0,
            total_steps: 0,
            finished: true,
        });
    }

    // 获取需要变基的提交数
    let mut revwalk = repo.revwalk()?;
    revwalk.push_range(&format!("{}..{}", merge_base, head_commit.id()))?;
    let commits_to_rebase: Vec<_> = revwalk.collect::<Result<Vec<_>, _>>()?;
    let total_steps = commits_to_rebase.len();

    // 执行变基操作
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["rebase", source_branch])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["rebase", source_branch])
        .current_dir(path)
        .output()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if output.status.success() {
        info!("变基成功完成");
        Ok(GitRebaseResult {
            success: true,
            has_conflicts: false,
            conflicts: vec![],
            rebased_commits: total_steps,
            current_step: total_steps,
            total_steps,
            finished: true,
        })
    } else {
        // 检查是否有冲突
        let has_conflicts = stderr.contains("CONFLICT")
            || stderr.contains("conflict")
            || stdout.contains("CONFLICT");

        // 获取冲突文件列表
        let conflicts = if has_conflicts {
            get_conflict_files(path)?
        } else {
            vec![]
        };

        // 获取当前步骤信息
        let current_step = if has_conflicts {
            let step_re = regex::Regex::new(r"Rebasing \((\d+)/(\d+)\)").unwrap();
            if let Some(caps) = step_re.captures(&stderr) {
                caps[1].parse().unwrap_or(1)
            } else {
                1
            }
        } else {
            0
        };

        if has_conflicts {
            info!("变基遇到冲突: {} 个文件", conflicts.len());
            Ok(GitRebaseResult {
                success: false,
                has_conflicts: true,
                conflicts,
                rebased_commits: 0,
                current_step,
                total_steps,
                finished: false,
            })
        } else {
            Err(GitServiceError::CLIError(stderr.to_string()))
        }
    }
}

/// 中止变基操作
pub fn rebase_abort(path: &Path) -> Result<(), GitServiceError> {
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["rebase", "--abort"])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["rebase", "--abort"])
        .current_dir(path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitServiceError::CLIError(stderr.to_string()));
    }

    Ok(())
}

/// 继续变基操作
pub fn rebase_continue(path: &Path) -> Result<GitRebaseResult, GitServiceError> {
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["rebase", "--continue"])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["rebase", "--continue"])
        .current_dir(path)
        .output()?;

    let _stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if output.status.success() {
        Ok(GitRebaseResult {
            success: true,
            has_conflicts: false,
            conflicts: vec![],
            rebased_commits: 0,
            current_step: 0,
            total_steps: 0,
            finished: true,
        })
    } else {
        let has_conflicts = stderr.contains("CONFLICT") || stderr.contains("conflict");

        let conflicts = if has_conflicts { get_conflict_files(path)? } else { vec![] };

        if has_conflicts {
            Ok(GitRebaseResult {
                success: false,
                has_conflicts: true,
                conflicts,
                rebased_commits: 0,
                current_step: 0,
                total_steps: 0,
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
