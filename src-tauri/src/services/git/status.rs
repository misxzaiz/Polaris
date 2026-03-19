/*! Git 状态查询
 *
 * 提供仓库状态、文件状态、领先/落后计算等功能
 */

use git2::{BranchType, Repository, StatusOptions};
use std::collections::HashMap;
use std::path::Path;
use tracing::{debug, info, warn};

use crate::models::git::{GitFileChange, GitFileStatus, GitRepositoryStatus};
use super::executor::open_repository;
use super::utils::{FileStatusFlags, FileStatusInfo};

/// 获取仓库状态
pub fn get_status(path: &Path) -> Result<GitRepositoryStatus, crate::models::git::GitServiceError> {
    debug!("开始获取仓库状态，路径: {:?}", path);

    let repo = match open_repository(path) {
        Ok(r) => {
            debug!("仓库打开成功");
            r
        }
        Err(e) => {
            tracing::error!("仓库打开失败: {:?}", e);
            return Err(e);
        }
    };

    // 检查是否为空仓库
    let is_empty = repo.is_empty().unwrap_or(true);
    debug!("仓库是否为空: {}", is_empty);

    // 获取 HEAD 信息 - 处理引用不存在的情况
    let (branch, commit, short_commit) = if is_empty {
        // 空仓库：通过 HEAD 引用的 symbolic_target 获取分支名
        let branch_name = repo.find_reference("HEAD")
            .ok()
            .and_then(|r| r.symbolic_target().map(|s| s.to_string()))
            .and_then(|s| {
                s.strip_prefix("refs/heads/")
                    .map(|s| s.to_string())
                    .or(Some(s))
            })
            .unwrap_or_default();
        debug!("空仓库分支名: {}", branch_name);
        (branch_name, String::new(), String::new())
    } else {
        match repo.head() {
            Ok(head) => {
                let branch_name = head.shorthand().unwrap_or("HEAD").to_string();
                match head.target() {
                    Some(oid) => {
                        let commit_str = oid.to_string();
                        let short_str = commit_str.chars().take(8).collect();
                        (branch_name, commit_str, short_str)
                    }
                    None => {
                        // HEAD 引用存在但无目标，可能是分离状态
                        (branch_name, String::new(), String::new())
                    }
                }
            }
            Err(e) => {
                // HEAD 引用不存在（可能是分支被删除但HEAD仍指向它）
                warn!("无法获取 HEAD 引用: {:?}，尝试从其他来源获取状态", e);
                // 尝试获取文件状态，即使 HEAD 有问题
                (String::new(), String::new(), String::new())
            }
        }
    };

    // 计算领先/落后
    let (ahead, behind) = if !is_empty && !branch.is_empty() {
        get_ahead_behind(&repo, &branch).unwrap_or((0, 0))
    } else {
        (0, 0)
    };

    // 获取文件状态
    let (staged, unstaged, untracked, conflicted) = parse_statuses(&repo)?;

    Ok(GitRepositoryStatus {
        exists: true,
        branch,
        commit,
        short_commit,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
        conflicted,
        is_empty,
    })
}

/// 解析文件状态（重构版：合并多状态条目）
fn parse_statuses(
    repo: &Repository,
) -> Result<
    (Vec<GitFileChange>, Vec<GitFileChange>, Vec<String>, Vec<String>),
    crate::models::git::GitServiceError,
> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut opts))?;

    // 使用 HashMap 合并同一文件的多个状态条目
    let mut file_map: HashMap<String, FileStatusInfo> = HashMap::new();

    for entry in statuses.iter() {
        let status = entry.status();
        let path = entry.path().unwrap_or("").to_string();

        if path.is_empty() {
            continue;
        }

        debug!("处理文件: {}, status: {:?}", path, status);
        debug!(
            "  索引: new={} modified={} deleted={} renamed={}",
            status.is_index_new(),
            status.is_index_modified(),
            status.is_index_deleted(),
            status.is_index_renamed()
        );
        debug!(
            "  工作区: new={} modified={} deleted={} renamed={}",
            status.is_wt_new(),
            status.is_wt_modified(),
            status.is_wt_deleted(),
            status.is_wt_renamed()
        );

        // 获取或创建文件状态信息
        let info = file_map.entry(path.clone()).or_insert_with(|| FileStatusInfo {
            path: path.clone(),
            flags: FileStatusFlags::empty(),
        });

        // 合并索引状态
        if status.is_index_new() {
            info.flags |= FileStatusFlags::INDEX_NEW;
        }
        if status.is_index_modified() {
            info.flags |= FileStatusFlags::INDEX_MODIFIED;
        }
        if status.is_index_deleted() {
            info.flags |= FileStatusFlags::INDEX_DELETED;
        }
        if status.is_index_renamed() {
            info.flags |= FileStatusFlags::INDEX_RENAMED;
        }

        // 合并工作区状态
        if status.is_wt_new() {
            info.flags |= FileStatusFlags::WT_NEW;
        }
        if status.is_wt_modified() {
            info.flags |= FileStatusFlags::WT_MODIFIED;
        }
        if status.is_wt_deleted() {
            info.flags |= FileStatusFlags::WT_DELETED;
        }
        if status.is_wt_renamed() {
            info.flags |= FileStatusFlags::WT_RENAMED;
        }
        if status.is_conflicted() {
            info.flags |= FileStatusFlags::CONFLICTED;
        }
    }

    // 根据合并后的状态进行分类
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    let mut conflicted = Vec::new();

    for (_path, info) in file_map.into_iter() {
        debug!("分类文件: {}", info.path);
        debug!(
            "  索引状态: new={} mod={} del={} ren={}",
            info.flags.contains(FileStatusFlags::INDEX_NEW),
            info.flags.contains(FileStatusFlags::INDEX_MODIFIED),
            info.flags.contains(FileStatusFlags::INDEX_DELETED),
            info.flags.contains(FileStatusFlags::INDEX_RENAMED)
        );
        debug!(
            "  工作区状态: new={} mod={} del={} ren={}",
            info.flags.contains(FileStatusFlags::WT_NEW),
            info.flags.contains(FileStatusFlags::WT_MODIFIED),
            info.flags.contains(FileStatusFlags::WT_DELETED),
            info.flags.contains(FileStatusFlags::WT_RENAMED)
        );

        // 冲突文件优先处理
        if info.flags.contains(FileStatusFlags::CONFLICTED) {
            conflicted.push(info.path.clone());
        }

        // === 已暂存区分类逻辑 ===
        let index_flags = FileStatusFlags::INDEX_NEW
            | FileStatusFlags::INDEX_MODIFIED
            | FileStatusFlags::INDEX_DELETED
            | FileStatusFlags::INDEX_RENAMED;

        // 如果文件在索引中有任何变更，则加入 staged 列表
        if info.flags.intersects(index_flags) {
            let status = if info.flags.contains(FileStatusFlags::INDEX_NEW) {
                GitFileStatus::Added
            } else if info.flags.contains(FileStatusFlags::INDEX_DELETED) {
                GitFileStatus::Deleted
            } else if info.flags.contains(FileStatusFlags::INDEX_RENAMED) {
                GitFileStatus::Renamed
            } else {
                GitFileStatus::Modified
            };

            debug!("  -> 加入 staged (状态: {:?})", status);
            staged.push(GitFileChange {
                path: info.path.clone(),
                status,
                old_path: None,
                additions: None,
                deletions: None,
            });
        }

        // === 未暂存区分类逻辑 ===
        let wt_flags = FileStatusFlags::WT_NEW
            | FileStatusFlags::WT_MODIFIED
            | FileStatusFlags::WT_DELETED
            | FileStatusFlags::WT_RENAMED;

        // 关键：即使文件在索引中有变更，只要工作区也有变更，也要在 unstaged 中显示
        if info.flags.intersects(wt_flags) {
            // 如果是纯新增文件（untracked），放入 untracked
            if info.flags.contains(FileStatusFlags::WT_NEW) && !info.flags.intersects(index_flags) {
                untracked.push(info.path.clone());
                debug!("  -> 加入 untracked (纯新增)");
            } else {
                // 其他情况都视为修改，加入 unstaged
                let status = if info.flags.contains(FileStatusFlags::WT_NEW) {
                    GitFileStatus::Added
                } else if info.flags.contains(FileStatusFlags::WT_DELETED) {
                    GitFileStatus::Deleted
                } else if info.flags.contains(FileStatusFlags::WT_RENAMED) {
                    GitFileStatus::Renamed
                } else {
                    GitFileStatus::Modified
                };

                debug!("  -> 加入 unstaged (状态: {:?})", status);
                unstaged.push(GitFileChange {
                    path: info.path.clone(),
                    status,
                    old_path: None,
                    additions: None,
                    deletions: None,
                });
            }
        }
    }

    info!(
        "parse_statuses 完成: staged={}, unstaged={}, untracked={}, conflicted={}",
        staged.len(),
        unstaged.len(),
        untracked.len(),
        conflicted.len()
    );
    debug!(
        "  staged paths: {:?}",
        staged.iter().map(|f| &f.path).collect::<Vec<_>>()
    );
    debug!(
        "  unstaged paths: {:?}",
        unstaged.iter().map(|f| &f.path).collect::<Vec<_>>()
    );
    debug!("  untracked paths: {:?}", untracked);

    Ok((staged, unstaged, untracked, conflicted))
}

/// 计算分支的领先/落后
fn get_ahead_behind(
    repo: &Repository,
    branch_name: &str,
) -> Result<(usize, usize), crate::models::git::GitServiceError> {
    let branch = repo
        .find_branch(branch_name, BranchType::Local)
        .or_else(|_| repo.find_branch(branch_name, BranchType::Remote))?;

    // 尝试获取上游分支
    let upstream = branch.upstream();

    if let Ok(upstream_branch) = upstream {
        let branch_oid = branch.get().target().ok_or_else(|| {
            crate::models::git::GitServiceError::BranchNotFound(branch_name.to_string())
        })?;
        let upstream_oid = upstream_branch
            .get()
            .target()
            .ok_or_else(|| crate::models::git::GitServiceError::BranchNotFound("upstream".to_string()))?;

        Ok(repo.graph_ahead_behind(branch_oid, upstream_oid)?)
    } else {
        Ok((0, 0))
    }
}
