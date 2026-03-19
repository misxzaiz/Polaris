/**
 * Git Diff 操作
 *
 * 提供各种 Diff 查询功能：工作区 Diff、暂存区 Diff、文件 Diff 等
 */

use git2::{Diff, DiffDelta, DiffOptions, Oid, Repository};
use std::path::Path;
use tracing::debug;

use crate::models::git::{
    DiffChangeType, GitDiffEntry, GitDiffStatusHint, GitServiceError,
};
use super::executor::open_repository;
use super::utils::{is_binary_by_extension, is_binary_bytes, MAX_INLINE_DIFF_BYTES};

/// 获取 Diff（HEAD vs 指定 commit）
pub fn get_diff(path: &Path, base_commit: &str) -> Result<Vec<GitDiffEntry>, GitServiceError> {
    let repo = open_repository(path)?;

    let base_oid = Oid::from_str(base_commit)
        .map_err(|_| GitServiceError::CommitNotFound(base_commit.to_string()))?;
    let base_commit_obj = repo
        .find_commit(base_oid)
        .map_err(|_| GitServiceError::CommitNotFound(base_commit.to_string()))?;
    let base_tree = base_commit_obj.tree()?;

    let head = repo.head()?;
    let head_commit = head.peel_to_commit()?;
    let head_tree = head_commit.tree()?;

    // 计算 Diff
    let mut diff_opts = DiffOptions::new();
    diff_opts.include_typechange(true);

    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut diff_opts))?;

    convert_diff(&repo, &diff)
}

/// 获取工作区 Diff（未暂存的变更）
pub fn get_worktree_diff(path: &Path) -> Result<Vec<GitDiffEntry>, GitServiceError> {
    let repo = open_repository(path)?;

    let head = repo.head()?;
    let head_commit = head.peel_to_commit()?;
    let head_tree = head_commit.tree()?;

    let diff = repo.diff_tree_to_workdir(Some(&head_tree), None)?;

    convert_diff(&repo, &diff)
}

/// 获取暂存区 Diff（已暂存的变更）
pub fn get_index_diff(path: &Path) -> Result<Vec<GitDiffEntry>, GitServiceError> {
    let repo = open_repository(path)?;

    let head = repo.head()?;
    let head_commit = head.peel_to_commit()?;
    let head_tree = head_commit.tree()?;

    let diff = repo.diff_tree_to_index(Some(&head_tree), None, None)?;

    convert_diff(&repo, &diff)
}

/// 获取单个文件在工作区的 Diff（智能版）
pub fn get_worktree_file_diff(
    path: &Path,
    file_path: &str,
) -> Result<GitDiffEntry, GitServiceError> {
    debug!("=== get_worktree_file_diff 开始 ===");
    debug!("工作区路径: {:?}", path);
    debug!("文件路径: {}", file_path);

    let repo = open_repository(path)?;
    debug!("打开仓库成功");

    // 1. 获取文件的详细状态
    let mut status_opts = git2::StatusOptions::new();
    status_opts.pathspec(file_path);
    status_opts.include_untracked(true);
    status_opts.recurse_untracked_dirs(false);

    let statuses = repo.statuses(Some(&mut status_opts))?;
    debug!("获取文件状态成功");

    if let Some(entry) = statuses.iter().next() {
        let status = entry.status();

        debug!("文件: {}, 状态: {:?}", file_path, status);
        debug!(
            "  is_index_new: {}, is_index_modified: {}, is_index_deleted: {}",
            status.is_index_new(),
            status.is_index_modified(),
            status.is_index_deleted()
        );
        debug!(
            "  is_wt_new: {}, is_wt_modified: {}, is_wt_deleted: {}",
            status.is_wt_new(),
            status.is_wt_modified(),
            status.is_wt_deleted()
        );

        // 2. 判断文件在工作区的状态，决定使用哪种 diff 方法
        if status.is_index_new() || status.is_index_modified() {
            debug!("文件已暂存，使用 get_diff_index_to_workdir (暂存区 vs 工作区)");
            return get_diff_index_to_workdir(&repo, file_path);
        }

        debug!("文件未暂存或暂存区删除，使用 get_diff_head_to_workdir_direct (HEAD vs 工作区)");
        return get_diff_head_to_workdir_direct(&repo, file_path);
    }

    // 3. 如果没有获取到状态，可能是未跟踪文件
    debug!("未获取到文件状态，使用 get_diff_head_to_workdir_direct (HEAD vs 工作区)");
    get_diff_head_to_workdir_direct(&repo, file_path)
}

/// 获取单个文件在暂存区的 Diff
pub fn get_index_file_diff(path: &Path, file_path: &str) -> Result<GitDiffEntry, GitServiceError> {
    let repo = open_repository(path)?;

    let head = repo.head()?;
    let head_commit = head.peel_to_commit()?;
    let head_tree = head_commit.tree()?;

    // 创建 DiffOptions 并指定路径
    let mut diffopts = DiffOptions::new();
    diffopts.pathspec(file_path);
    diffopts.ignore_case(false);

    let diff = repo.diff_tree_to_index(Some(&head_tree), None, Some(&mut diffopts))?;

    let entries = convert_diff(&repo, &diff)?;
    entries.into_iter().next().ok_or_else(|| {
        GitServiceError::CLIError(format!("文件 {} 没有变更", file_path))
    })
}

/// 将 git2::Diff 转换为 GitDiffEntry
fn convert_diff(repo: &Repository, diff: &Diff) -> Result<Vec<GitDiffEntry>, GitServiceError> {
    let mut entries = Vec::new();

    for delta in diff.deltas() {
        let new_path = delta.new_file().path();
        let old_path = delta.old_file().path();

        let file_path = new_path
            .or(old_path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let old_file_path = if delta.status() == git2::Delta::Renamed
            || delta.status() == git2::Delta::Copied
        {
            old_path.map(|p| p.to_string_lossy().to_string())
        } else {
            None
        };

        let change_type = match delta.status() {
            git2::Delta::Added => DiffChangeType::Added,
            git2::Delta::Deleted => DiffChangeType::Deleted,
            git2::Delta::Modified => DiffChangeType::Modified,
            git2::Delta::Renamed => DiffChangeType::Renamed,
            git2::Delta::Copied => DiffChangeType::Copied,
            _ => DiffChangeType::Modified,
        };

        // 计算行数变化
        let (additions, deletions) = compute_line_stats(diff, &delta);

        // 检查是否为二进制文件
        let is_binary = delta.new_file().is_binary() || delta.old_file().is_binary();

        // 获取文件内容
        let (old_content, new_content, content_omitted) = if is_binary {
            (None, None, Some(true))
        } else {
            get_diff_content(repo, &delta, &change_type)?
        };

        // 添加状态提示
        let status_hint = Some(GitDiffStatusHint {
            has_conflict: false,
            message: None,
            current_view: "HEAD vs 暂存区".to_string(),
        });

        entries.push(GitDiffEntry {
            file_path: file_path.clone(),
            old_file_path,
            change_type,
            old_content,
            new_content,
            additions: Some(additions),
            deletions: Some(deletions),
            is_binary,
            content_omitted,
            status_hint,
        });
    }

    Ok(entries)
}

/// 计算增删行数
fn compute_line_stats(_diff: &Diff, _delta: &DiffDelta) -> (usize, usize) {
    // TODO: 实现准确的行数统计
    (0, 0)
}

/// 获取 Diff 的文件内容
fn get_diff_content(
    repo: &Repository,
    delta: &DiffDelta,
    change_type: &DiffChangeType,
) -> Result<(Option<String>, Option<String>, Option<bool>), GitServiceError> {
    let old_content = if !matches!(change_type, DiffChangeType::Added) {
        let oid = delta.old_file().id();
        if !oid.is_zero() {
            match repo.find_blob(oid) {
                Ok(blob) => {
                    if blob.size() > MAX_INLINE_DIFF_BYTES || blob.is_binary() {
                        Some(None)
                    } else {
                        Some(
                            std::str::from_utf8(blob.content())
                                .ok()
                                .map(|s| s.to_string()),
                        )
                    }
                }
                Err(_) => Some(None),
            }
        } else {
            Some(None)
        }
    } else {
        Some(None)
    };

    // 当 OID 为零时（工作区文件），从文件系统读取
    let new_content = if !matches!(change_type, DiffChangeType::Deleted) {
        let oid = delta.new_file().id();
        if !oid.is_zero() {
            match repo.find_blob(oid) {
                Ok(blob) => {
                    if blob.size() > MAX_INLINE_DIFF_BYTES || blob.is_binary() {
                        Some(None)
                    } else {
                        Some(
                            std::str::from_utf8(blob.content())
                                .ok()
                                .map(|s| s.to_string()),
                        )
                    }
                }
                Err(_) => Some(None),
            }
        } else {
            // OID 为零，尝试从工作区读取文件
            if let Some(path) = delta.new_file().path() {
                let workdir = repo.workdir().ok_or(GitServiceError::NotARepository)?;
                let full_path = workdir.join(path);

                if is_binary_by_extension(&full_path) {
                    Some(None)
                } else {
                    let metadata = std::fs::metadata(&full_path);
                    if let Ok(meta) = metadata {
                        if meta.len() > MAX_INLINE_DIFF_BYTES as u64 {
                            Some(None)
                        } else {
                            match std::fs::read(&full_path) {
                                Ok(bytes) => {
                                    if is_binary_bytes(&bytes) {
                                        Some(None)
                                    } else {
                                        std::str::from_utf8(&bytes)
                                            .ok()
                                            .map(|s| s.to_string())
                                            .map(Some)
                                    }
                                }
                                Err(_) => Some(None),
                            }
                        }
                    } else {
                        Some(None)
                    }
                }
            } else {
                Some(None)
            }
        }
    } else {
        Some(None)
    };

    // 计算是否省略内容
    let content_omitted = matches!(&old_content, Some(None)) || matches!(&new_content, Some(None));

    // 提取内容
    let old = old_content.and_then(|o| o);
    let new = new_content.and_then(|n| n);

    Ok((old, new, if content_omitted { Some(true) } else { None }))
}

/// 直接比较 HEAD 和工作区（绕过暂存区）
fn get_diff_head_to_workdir_direct(
    repo: &Repository,
    file_path: &str,
) -> Result<GitDiffEntry, GitServiceError> {
    // 1. 获取 HEAD 内容
    let head = repo.head()?;
    let head_commit = head.peel_to_commit()?;
    let head_tree = head_commit.tree()?;

    let old_content: Option<Option<String>> =
        if let Ok(entry) = head_tree.get_path(std::path::Path::new(file_path)) {
            let obj = entry.to_object(repo)?;
            if let Some(blob) = obj.as_blob() {
                if blob.size() > MAX_INLINE_DIFF_BYTES || blob.is_binary() {
                    Some(None)
                } else {
                    Some(
                        std::str::from_utf8(blob.content())
                            .ok()
                            .map(|s| s.to_string()),
                    )
                }
            } else {
                Some(None)
            }
        } else {
            None
        };

    // 2. 读取工作区内容
    let workdir = repo.workdir().ok_or(GitServiceError::NotARepository)?;
    let full_path = workdir.join(file_path);

    let new_content: Option<Option<String>> = if full_path.exists() {
        if is_binary_by_extension(&full_path) {
            Some(None)
        } else {
            let metadata = std::fs::metadata(&full_path);
            if let Ok(meta) = metadata {
                if meta.len() > MAX_INLINE_DIFF_BYTES as u64 {
                    Some(None)
                } else {
                    match std::fs::read(&full_path) {
                        Ok(bytes) => {
                            let is_bin = is_binary_bytes(&bytes);
                            if is_bin {
                                Some(None)
                            } else {
                                Some(
                                    std::str::from_utf8(&bytes)
                                        .ok()
                                        .map(|s| s.to_string()),
                                )
                            }
                        }
                        Err(_) => Some(None),
                    }
                }
            } else {
                Some(None)
            }
        }
    } else {
        None
    };

    // 3. 判断变更类型
    let change_type = match (&old_content, &new_content) {
        (Some(_), Some(_)) => DiffChangeType::Modified,
        (Some(_), None) => DiffChangeType::Deleted,
        (None, Some(_)) => DiffChangeType::Added,
        (None, None) => return Err(GitServiceError::CLIError("文件无变更".into())),
    };

    // 4. 计算 content_omitted
    let content_omitted =
        matches!(&old_content, Some(None)) || matches!(&new_content, Some(None));

    // 5. 判断是否为二进制
    let is_binary = matches!(&new_content, Some(None));

    // 6. 提取内容
    let old = old_content.and_then(|o| o);
    let new = new_content.and_then(|n| n);

    // 7. 计算 diff 行数
    let (additions, deletions) = if !is_binary {
        if let (Some(old), Some(new)) = (&old, &new) {
            compute_line_diff(old, new)
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };

    // 8. 构建状态提示
    let status_hint = Some(GitDiffStatusHint {
        has_conflict: false,
        message: None,
        current_view: "HEAD vs 工作区".to_string(),
    });

    Ok(GitDiffEntry {
        file_path: file_path.to_string(),
        old_file_path: None,
        change_type,
        old_content: old,
        new_content: new,
        additions: Some(additions),
        deletions: Some(deletions),
        is_binary,
        content_omitted: if content_omitted { Some(true) } else { None },
        status_hint,
    })
}

/// 比较暂存区和工作区
fn get_diff_index_to_workdir(
    repo: &Repository,
    file_path: &str,
) -> Result<GitDiffEntry, GitServiceError> {
    debug!("=== get_diff_index_to_workdir 开始 ===");
    debug!("文件路径: {}", file_path);

    // 1. 获取暂存区内容
    let index = repo.index()?;
    debug!("获取暂存区 index 成功");

    let old_content: Option<Option<String>> =
        if let Some(entry) = index.get_path(std::path::Path::new(file_path), 0) {
            let id = entry.id;
            debug!("暂存区找到文件条目，blob id: {:?}", id);
            if let Ok(blob) = repo.find_blob(id) {
                if blob.size() > MAX_INLINE_DIFF_BYTES {
                    debug!("暂存区内容超过大小限制");
                    Some(None)
                } else if blob.is_binary() {
                    debug!("暂存区内容为二进制");
                    Some(None)
                } else {
                    let content =
                        std::str::from_utf8(blob.content()).ok().map(|s| s.to_string());
                    debug!(
                        "从 blob 读取暂存区内容成功，长度: {:?}",
                        content.as_ref().map(|s| s.len())
                    );
                    Some(content)
                }
            } else {
                debug!("从 blob 读取暂存区内容失败");
                Some(None)
            }
        } else {
            debug!("暂存区中没有该文件条目");
            None
        };

    // 2. 读取工作区内容
    let workdir = repo.workdir().ok_or(GitServiceError::NotARepository)?;
    let full_path = workdir.join(file_path);
    debug!("工作区完整路径: {:?}", full_path);

    let new_content: Option<Option<String>> = if full_path.exists() {
        if is_binary_by_extension(&full_path) {
            Some(None)
        } else {
            match std::fs::read(&full_path) {
                Ok(bytes) => {
                    let is_bin = is_binary_bytes(&bytes);
                    debug!("从文件系统读取工作区内容成功，字节长度: {}", bytes.len());
                    if is_bin || bytes.len() > MAX_INLINE_DIFF_BYTES {
                        Some(None)
                    } else {
                        let content =
                            std::str::from_utf8(&bytes).ok().map(|s| s.to_string());
                        debug!("工作区文本内容长度: {:?}", content.as_ref().map(|s| s.len()));
                        Some(content)
                    }
                }
                Err(e) => {
                    debug!("从文件系统读取工作区内容失败: {:?}", e);
                    Some(None)
                }
            }
        }
    } else {
        debug!("工作区文件不存在");
        None
    };

    let is_binary = matches!(&new_content, Some(None));

    // 3. 判断变更类型
    let change_type = match (&old_content, &new_content) {
        (Some(_), Some(_)) => {
            debug!("变更类型: Modified");
            DiffChangeType::Modified
        }
        (Some(_), None) => {
            debug!("变更类型: Deleted");
            DiffChangeType::Deleted
        }
        (None, Some(_)) => {
            debug!("变更类型: Added");
            DiffChangeType::Added
        }
        (None, None) => {
            debug!("变更类型: 无变更");
            return Err(GitServiceError::CLIError("文件无变更".into()));
        }
    };

    // 4. 计算 content_omitted
    let content_omitted =
        matches!(&old_content, Some(None)) || matches!(&new_content, Some(None));

    // 5. 提取内容
    let old = old_content.and_then(|o| o);
    let new = new_content.and_then(|n| n);

    // 6. 计算行数
    let (additions, deletions) = if !is_binary {
        if let (Some(old), Some(new)) = (&old, &new) {
            let (adds, dels) = compute_line_diff(old, new);
            debug!("计算行 diff 完成: 新增 {} 行，删除 {} 行", adds, dels);
            (adds, dels)
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };

    // 7. 状态提示
    let status_hint = Some(GitDiffStatusHint {
        has_conflict: true,
        message: Some("暂存区和工作区都有修改".to_string()),
        current_view: "暂存区 vs 工作区".to_string(),
    });

    debug!("=== get_diff_index_to_workdir 完成 ===");

    Ok(GitDiffEntry {
        file_path: file_path.to_string(),
        old_file_path: None,
        change_type,
        old_content: old,
        new_content: new,
        additions: Some(additions),
        deletions: Some(deletions),
        is_binary,
        content_omitted: if content_omitted { Some(true) } else { None },
        status_hint,
    })
}

/// 计算行级 diff
pub fn compute_line_diff(old: &str, new: &str) -> (usize, usize) {
    use similar::{ChangeTag, TextDiff};

    let diff = TextDiff::from_lines(old, new);

    let mut additions = 0;
    let mut deletions = 0;

    for op in diff.iter_all_changes() {
        match op.tag() {
            ChangeTag::Insert => additions += 1,
            ChangeTag::Delete => deletions += 1,
            _ => {}
        }
    }

    (additions, deletions)
}
