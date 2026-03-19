/*! Git 提交操作
 *
 * 提供提交、暂存、取消暂存、丢弃变更等功能
 */

use git2::{Repository, StatusOptions};
use std::path::Path;
use tracing::{debug, info, warn};

use crate::models::git::{BatchStageResult, GitServiceError, StageFailure};
use super::executor::open_repository;

/// 提交变更
pub fn commit(
    path: &Path,
    message: &str,
    stage_all: bool,
    selected_files: Option<Vec<String>>,
) -> Result<String, GitServiceError> {
    let repo = open_repository(path)?;

    let mut index = repo.index()?;

    // 决定要暂存哪些文件
    let files_to_stage = if let Some(ref files) = selected_files {
        info!("只暂存选中的 {} 个文件", files.len());
        files.clone()
    } else if stage_all {
        info!("暂存所有变更文件");
        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .include_ignored(false)
            .recurse_untracked_dirs(true);

        let statuses = repo.statuses(Some(&mut opts))?;

        let mut all_files = Vec::new();
        for entry in statuses.iter() {
            if let Some(path_str) = entry.path() {
                all_files.push(path_str.to_string());
            }
        }
        all_files
    } else {
        info!("不暂存，直接提交已暂存内容");
        vec![]
    };

    if !files_to_stage.is_empty() {
        // Windows 保留名称列表
        let reserved = [
            "nul", "con", "prn", "aux", "com1", "com2", "com3", "com4", "lpt1", "lpt2", "lpt3",
        ];

        let mut added_count = 0;
        let mut removed_count = 0;

        let need_status_check = selected_files.is_none();

        let statuses = if need_status_check {
            let mut opts = StatusOptions::new();
            opts.include_untracked(true)
                .include_ignored(false)
                .recurse_untracked_dirs(true);
            Some(repo.statuses(Some(&mut opts))?)
        } else {
            None
        };

        for path_str in files_to_stage {
            let path_lower = path_str.to_lowercase();
            if reserved.iter().any(|&r| path_lower.contains(r)) {
                warn!("跳过 Windows 保留名称文件: {}", path_str);
                continue;
            }

            let path = std::path::Path::new(&path_str);

            if let Some(ref statuses) = statuses {
                let status = statuses
                    .iter()
                    .find(|e| e.path() == Some(&path_str))
                    .map(|e| e.status());

                if let Some(status) = status {
                    if status.is_wt_deleted() {
                        match index.remove(path, 0) {
                            Ok(_) => {
                                debug!("标记删除文件: {}", path_str);
                                removed_count += 1;
                            }
                            Err(e) => {
                                debug!("跳过删除文件 {}: {:?}", path_str, e);
                            }
                        }
                        continue;
                    }
                }
            }

            match index.add_path(path) {
                Ok(_) => {
                    added_count += 1;
                }
                Err(e) => {
                    debug!("跳过文件 {}: {:?}", path_str, e);
                }
            }
        }

        info!(
            "已添加 {} 个文件，移除 {} 个文件到暂存区",
            added_count, removed_count
        );

        index.write()?;
    }

    // 检查是否有变更
    if index.is_empty() {
        return Err(GitServiceError::CLIError("No changes to commit".to_string()));
    }

    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;

    let sig = repo.signature()?;

    let is_empty = repo.is_empty()?;

    let oid = if is_empty {
        info!("首次提交：创建初始分支");
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[])?
    } else {
        let head = repo.head()?;
        let parent_commit = head.peel_to_commit()?;

        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            message,
            &tree,
            &[&parent_commit],
        )?
    };

    Ok(oid.to_string())
}

/// 暂存文件
pub fn stage_file(path: &Path, file_path: &str) -> Result<(), GitServiceError> {
    let repo = open_repository(path)?;

    let mut index = repo.index()?;
    index.add_path(std::path::Path::new(file_path))?;
    index.write()?;

    Ok(())
}

/// 取消暂存文件
pub fn unstage_file(path: &Path, file_path: &str) -> Result<(), GitServiceError> {
    let repo = open_repository(path)?;

    let mut index = repo.index()?;
    index.remove_path(std::path::Path::new(file_path))?;
    index.write()?;

    Ok(())
}

/// 丢弃工作区变更
pub fn discard_changes(path: &Path, file_path: &str) -> Result<(), GitServiceError> {
    let repo = open_repository(path)?;

    let mut index = repo.index()?;

    // 从 HEAD 恢复文件
    let head = repo.head()?;
    let head_commit = head.peel_to_commit()?;
    let head_tree = head_commit.tree()?;

    let entry = head_tree.get_path(std::path::Path::new(file_path))?;

    let obj = entry.to_object(&repo)?;
    let blob = obj
        .as_blob()
        .ok_or(GitServiceError::CLIError("Not a blob".to_string()))?;

    // 写入文件
    let workdir = repo.workdir().ok_or(GitServiceError::NotARepository)?;
    let full_path = workdir.join(file_path);

    std::fs::write(&full_path, blob.content())?;

    // 更新索引
    index.add_path(std::path::Path::new(file_path))?;
    index.write()?;

    Ok(())
}

/// 批量暂存文件
pub fn batch_stage(path: &Path, file_paths: &[String]) -> Result<BatchStageResult, GitServiceError> {
    let repo = open_repository(path)?;
    let mut index = repo.index()?;

    let mut staged = Vec::new();
    let mut failed = Vec::new();

    for file_path in file_paths {
        let path_obj = std::path::Path::new(file_path);

        match index.add_path(path_obj) {
            Ok(_) => staged.push(file_path.clone()),
            Err(e) => failed.push(StageFailure {
                path: file_path.clone(),
                error: e.message().to_string(),
            }),
        }
    }

    index.write()?;

    Ok(BatchStageResult {
        total: file_paths.len(),
        staged,
        failed,
    })
}

/// 计算仓库中的跟踪文件数量（预留）
#[allow(dead_code)]
pub fn count_tracked_files(repo: &Repository) -> Result<usize, GitServiceError> {
    let head = repo.head()?;
    let head_commit = head.peel_to_commit()?;
    let tree = head_commit.tree()?;

    let mut count = 0;
    tree.walk(git2::TreeWalkMode::PreOrder, |_root, _entry| {
        count += 1;
        git2::TreeWalkResult::Ok
    })?;

    Ok(count)
}
