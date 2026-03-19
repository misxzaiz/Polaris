/*! Git 分支操作
 *
 * 提供分支的创建、切换、删除、重命名、合并等功能
 */

use git2::BranchType;
use std::path::Path;
use tracing::info;

use crate::models::git::{GitBranch, GitMergeResult, GitServiceError};
use super::executor::open_repository;

/// 获取所有分支
pub fn get_branches(path: &Path) -> Result<Vec<GitBranch>, GitServiceError> {
    let repo = open_repository(path)?;

    // 获取当前分支名 - 处理空仓库的情况
    let current_branch = if repo.is_empty().unwrap_or(true) {
        repo.find_reference("HEAD")
            .ok()
            .and_then(|r| r.symbolic_target().map(|s| s.to_string()))
            .and_then(|s| {
                s.strip_prefix("refs/heads/")
                    .map(|s| s.to_string())
                    .or(Some(s))
            })
            .unwrap_or_default()
    } else {
        repo.head()
            .ok()
            .and_then(|h| h.shorthand().map(|s| s.to_string()))
            .unwrap_or_default()
    };

    let mut branches = Vec::new();

    // 本地分支
    let local_branches = repo.branches(Some(BranchType::Local))?;
    for branch_result in local_branches {
        let (branch, _) = branch_result?;
        if let Some(name) = branch.name()? {
            let commit_oid = branch.get().target().unwrap_or(git2::Oid::zero());
            let commit = repo.find_commit(commit_oid);

            let last_commit_date = commit.ok().map(|c| {
                let time = c.time();
                time.seconds()
            });

            branches.push(GitBranch {
                name: name.to_string(),
                is_current: name == current_branch,
                is_remote: false,
                commit: commit_oid.to_string(),
                ahead: None,
                behind: None,
                last_commit_date,
            });
        }
    }

    // 远程分支
    let remote_branches = repo.branches(Some(BranchType::Remote))?;
    for branch_result in remote_branches {
        let (branch, _) = branch_result?;
        if let Some(name) = branch.name()? {
            // 跳过远程 HEAD 引用
            if !name.ends_with("/HEAD") {
                let commit_oid = branch.get().target().unwrap_or(git2::Oid::zero());

                branches.push(GitBranch {
                    name: name.to_string(),
                    is_current: false,
                    is_remote: true,
                    commit: commit_oid.to_string(),
                    ahead: None,
                    behind: None,
                    last_commit_date: None,
                });
            }
        }
    }

    Ok(branches)
}

/// 创建分支
pub fn create_branch(path: &Path, name: &str, checkout: bool) -> Result<(), GitServiceError> {
    let repo = open_repository(path)?;

    // 验证分支名
    if !git2::Branch::name_is_valid(name).unwrap_or(false) {
        return Err(GitServiceError::BranchNotFound(format!(
            "Invalid branch name: {}",
            name
        )));
    }

    // 检查是否为空仓库
    let is_empty = repo.is_empty().unwrap_or(true);

    if is_empty {
        // 空仓库：使用符号引用格式设置 HEAD
        if checkout {
            repo.set_head(&format!("ref: refs/heads/{}", name))?;
        }
        return Ok(());
    }

    // 非空仓库：正常创建分支
    let head = repo.head()?.peel_to_commit()?;

    repo.branch(name, &head, false)?;

    if checkout {
        let obj = repo.revparse_single(&format!("refs/heads/{}", name))?;
        repo.checkout_tree(&obj, None)?;
        repo.set_head(&format!("refs/heads/{}", name))?;
    }

    Ok(())
}

/// 切换分支
pub fn checkout_branch(path: &Path, name: &str) -> Result<(), GitServiceError> {
    let repo = open_repository(path)?;

    let obj = repo.revparse_single(name)?;
    repo.checkout_tree(&obj, None)?;
    repo.set_head(&format!("refs/heads/{}", name))?;

    Ok(())
}

/// 删除分支
pub fn delete_branch(path: &Path, name: &str, force: bool) -> Result<(), GitServiceError> {
    let repo = open_repository(path)?;

    // 获取当前分支名
    let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .unwrap_or_default();

    // 不能删除当前分支
    if name == current_branch {
        return Err(GitServiceError::CLIError(format!(
            "Cannot delete the current branch '{}'",
            name
        )));
    }

    // 查找分支
    let mut branch = repo.find_branch(name, BranchType::Local)?;

    // 检查是否已合并（如果不强制删除）
    if !force {
        let head = repo.head()?.peel_to_commit()?;
        let head_oid = head.id();

        let branch_commit = branch
            .get()
            .target()
            .ok_or_else(|| GitServiceError::BranchNotFound(name.to_string()))?;

        let is_merged = repo
            .merge_base(head_oid, branch_commit)
            .map(|base| base == branch_commit)
            .unwrap_or(false);

        if !is_merged {
            return Err(GitServiceError::CLIError(format!(
                "Branch '{}' is not fully merged. Use force option to delete anyway.",
                name
            )));
        }
    }

    // 删除分支
    branch.delete()?;

    Ok(())
}

/// 重命名分支
pub fn rename_branch(path: &Path, old_name: &str, new_name: &str) -> Result<(), GitServiceError> {
    let repo = open_repository(path)?;

    // 验证新分支名称
    let invalid_chars = [' ', '~', '^', ':', '?', '*', '[', '\\'];
    if new_name.chars().any(|c| invalid_chars.contains(&c)) {
        return Err(GitServiceError::CLIError(format!(
            "Invalid branch name '{}': contains illegal characters",
            new_name
        )));
    }

    // 检查新名称是否已存在
    if repo.find_branch(new_name, BranchType::Local).is_ok() {
        return Err(GitServiceError::CLIError(format!(
            "Branch '{}' already exists",
            new_name
        )));
    }

    // 查找要重命名的分支
    let mut branch = repo.find_branch(old_name, BranchType::Local)?;

    // 检查是否为当前分支
    let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .unwrap_or_default();

    let is_current = old_name == current_branch;

    // 执行重命名
    branch.rename(new_name, true)?;

    // 如果是当前分支，更新 HEAD 引用
    if is_current {
        repo.set_head(&format!("refs/heads/{}", new_name))?;
    }

    Ok(())
}

/// 合并分支
pub fn merge_branch(
    path: &Path,
    source_branch: &str,
    no_ff: bool,
) -> Result<GitMergeResult, GitServiceError> {
    info!("开始合并分支: {} -> 当前分支", source_branch);

    let repo = open_repository(path)?;

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

    // 不能合并到自身
    if current_branch == source_branch {
        return Err(GitServiceError::CLIError(format!(
            "Cannot merge branch '{}' into itself",
            source_branch
        )));
    }

    // 获取源分支的引用
    let source_ref = repo
        .find_branch(source_branch, BranchType::Local)
        .or_else(|_| repo.find_branch(source_branch, BranchType::Remote))?;

    let source_commit_oid = source_ref
        .get()
        .target()
        .ok_or_else(|| GitServiceError::BranchNotFound(source_branch.to_string()))?;

    // 创建 annotated commit
    let annotated_commit = repo.find_annotated_commit(source_commit_oid)?;

    // 获取当前 HEAD commit
    let head = repo.head()?;
    let head_commit = head.peel_to_commit()?;

    // 检查是否可以快进合并
    let can_fast_forward = !no_ff && {
        let merge_base = repo.merge_base(head_commit.id(), source_commit_oid)?;
        merge_base == head_commit.id()
    };

    if can_fast_forward {
        // 快进合并
        info!("执行快进合并");
        let source_commit = repo.find_commit(source_commit_oid)?;
        repo.checkout_tree(source_commit.tree()?.as_object(), None)?;
        repo.set_head(&format!("refs/heads/{}", current_branch))?;

        return Ok(GitMergeResult {
            success: true,
            fast_forward: true,
            has_conflicts: false,
            conflicts: vec![],
            merged_commits: 1,
            files_changed: 0,
        });
    }

    // 普通合并
    info!("执行普通合并");

    repo.merge(&[&annotated_commit], None, None)?;

    // 检查是否有冲突
    let mut index = repo.index()?;
    let has_conflicts = index.has_conflicts();

    // 获取冲突文件列表
    let conflicts = if has_conflicts {
        let mut conflict_list = Vec::new();
        for conflict in index.conflicts()?.flatten() {
            if let Some(our) = conflict.our {
                let path = String::from_utf8_lossy(&our.path).to_string();
                conflict_list.push(path);
            } else if let Some(their) = conflict.their {
                let path = String::from_utf8_lossy(&their.path).to_string();
                conflict_list.push(path);
            }
        }
        conflict_list
    } else {
        vec![]
    };

    // 如果没有冲突，自动提交
    let (merged_commits, files_changed) = if !has_conflicts {
        let merge_base = repo.merge_base(head_commit.id(), source_commit_oid)?;
        let mut revwalk = repo.revwalk()?;
        revwalk.push_range(&format!("{}..{}", merge_base, source_commit_oid))?;
        let merged_count = revwalk.count();

        let tree_id = index.write_tree()?;
        let tree = repo.find_tree(tree_id)?;

        let sig = repo.signature()?;
        let message = format!("Merge branch '{}' into {}", source_branch, current_branch);

        let source_commit = repo.find_commit(source_commit_oid)?;
        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            &message,
            &tree,
            &[&head_commit, &source_commit],
        )?;

        (merged_count, 0)
    } else {
        (0, 0)
    };

    Ok(GitMergeResult {
        success: !has_conflicts,
        fast_forward: false,
        has_conflicts,
        conflicts,
        merged_commits,
        files_changed,
    })
}
