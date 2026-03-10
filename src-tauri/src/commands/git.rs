/**
 * Git Tauri Commands
 *
 * 前端调用的 Git 操作命令
 */

use crate::models::git::*;
use crate::services::git::GitService;
use std::path::PathBuf;

/// 检查路径是否为 Git 仓库
#[tauri::command]
pub fn git_is_repository(workspacePath: String) -> Result<bool, GitError> {
    let path = PathBuf::from(workspacePath);
    Ok(GitService::is_repository(&path))
}

/// 初始化 Git 仓库
#[tauri::command]
pub fn git_init_repository(
    workspacePath: String,
    initialBranch: Option<String>,
) -> Result<String, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::init_repository(&path, initialBranch.as_deref())
        .map_err(GitError::from)
}

/// 获取仓库状态
#[tauri::command]
pub fn git_get_status(workspacePath: String) -> Result<GitRepositoryStatus, GitError> {
    eprintln!("[Tauri Command] git_get_status 被调用，路径: {}", workspacePath);

    let path = PathBuf::from(workspacePath);

    match GitService::get_status(&path) {
        Ok(status) => {
            eprintln!("[Tauri Command] git_get_status 成功");
            Ok(status)
        }
        Err(e) => {
            eprintln!("[Tauri Command] git_get_status 失败: {:?}", e);
            Err(GitError::from(e))
        }
    }
}

/// 获取 Diff (HEAD vs 指定 commit)
#[tauri::command]
pub fn git_get_diffs(
    workspacePath: String,
    baseCommit: String,
) -> Result<Vec<GitDiffEntry>, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::get_diff(&path, &baseCommit).map_err(GitError::from)
}

/// 获取工作区 Diff (未暂存的变更)
#[tauri::command]
pub fn git_get_worktree_diff(workspacePath: String) -> Result<Vec<GitDiffEntry>, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::get_worktree_diff(&path).map_err(GitError::from)
}

/// 获取暂存区 Diff (已暂存的变更)
#[tauri::command]
pub fn git_get_index_diff(workspacePath: String) -> Result<Vec<GitDiffEntry>, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::get_index_diff(&path).map_err(GitError::from)
}

/// 获取单个文件在工作区的 Diff
#[tauri::command]
pub fn git_get_worktree_file_diff(
    workspacePath: String,
    filePath: String,
) -> Result<GitDiffEntry, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::get_worktree_file_diff(&path, &filePath).map_err(GitError::from)
}

/// 获取单个文件在暂存区的 Diff
#[tauri::command]
pub fn git_get_index_file_diff(
    workspacePath: String,
    filePath: String,
) -> Result<GitDiffEntry, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::get_index_file_diff(&path, &filePath).map_err(GitError::from)
}

/// 获取所有分支
#[tauri::command]
pub fn git_get_branches(workspacePath: String) -> Result<Vec<GitBranch>, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::get_branches(&path).map_err(GitError::from)
}

/// 获取所有标签
#[tauri::command]
pub fn git_get_tags(workspacePath: String) -> Result<Vec<GitTag>, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::get_tags(&path).map_err(GitError::from)
}

/// 创建标签
#[tauri::command]
pub fn git_create_tag(
    workspacePath: String,
    name: String,
    commitish: Option<String>,
    message: Option<String>,
) -> Result<GitTag, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::create_tag(&path, &name, commitish.as_deref(), message.as_deref())
        .map_err(GitError::from)
}

/// 删除标签
#[tauri::command]
pub fn git_delete_tag(workspacePath: String, name: String) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::delete_tag(&path, &name).map_err(GitError::from)
}

/// 创建分支
#[tauri::command]
pub fn git_create_branch(
    workspacePath: String,
    name: String,
    checkout: bool,
) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::create_branch(&path, &name, checkout).map_err(GitError::from)
}

/// 切换分支
#[tauri::command]
pub fn git_checkout_branch(
    workspacePath: String,
    name: String,
) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::checkout_branch(&path, &name).map_err(GitError::from)
}

/// 删除分支
#[tauri::command]
pub fn git_delete_branch(
    workspacePath: String,
    name: String,
    force: bool,
) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::delete_branch(&path, &name, force).map_err(GitError::from)
}

/// 重命名分支
#[tauri::command]
pub fn git_rename_branch(
    workspacePath: String,
    oldName: String,
    newName: String,
) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::rename_branch(&path, &oldName, &newName).map_err(GitError::from)
}

/// 合并分支
#[tauri::command]
pub fn git_merge_branch(
    workspacePath: String,
    sourceBranch: String,
    noFF: bool,
) -> Result<GitMergeResult, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::merge_branch(&path, &sourceBranch, noFF).map_err(GitError::from)
}

/// 变基分支
#[tauri::command]
pub fn git_rebase_branch(
    workspacePath: String,
    sourceBranch: String,
) -> Result<GitRebaseResult, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::rebase_branch(&path, &sourceBranch).map_err(GitError::from)
}

/// 中止变基
#[tauri::command]
pub fn git_rebase_abort(workspacePath: String) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::rebase_abort(&path).map_err(GitError::from)
}

/// 继续变基
#[tauri::command]
pub fn git_rebase_continue(workspacePath: String) -> Result<GitRebaseResult, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::rebase_continue(&path).map_err(GitError::from)
}

/// Cherry-pick 提交
#[tauri::command]
pub fn git_cherry_pick(
    workspacePath: String,
    commitSha: String,
) -> Result<GitCherryPickResult, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::cherry_pick(&path, &commitSha).map_err(GitError::from)
}

/// 中止 Cherry-pick
#[tauri::command]
pub fn git_cherry_pick_abort(workspacePath: String) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::cherry_pick_abort(&path).map_err(GitError::from)
}

/// 继续 Cherry-pick
#[tauri::command]
pub fn git_cherry_pick_continue(workspacePath: String) -> Result<GitCherryPickResult, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::cherry_pick_continue(&path).map_err(GitError::from)
}

/// Revert 提交
#[tauri::command]
pub fn git_revert(
    workspacePath: String,
    commitSha: String,
) -> Result<GitRevertResult, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::revert(&path, &commitSha).map_err(GitError::from)
}

/// 中止 Revert
#[tauri::command]
pub fn git_revert_abort(workspacePath: String) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::revert_abort(&path).map_err(GitError::from)
}

/// 继续 Revert
#[tauri::command]
pub fn git_revert_continue(workspacePath: String) -> Result<GitRevertResult, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::revert_continue(&path).map_err(GitError::from)
}

/// 提交变更
#[tauri::command]
pub async fn git_commit_changes(
    workspacePath: String,
    message: String,
    stageAll: bool,
    selectedFiles: Option<Vec<String>>,
) -> Result<String, GitError> {
    // 在后台线程执行同步的 Git 操作，避免阻塞主线程
    let path = workspacePath.clone();
    let msg = message.clone();
    let files = selectedFiles.clone();

    let result = tokio::task::spawn_blocking(move || {
        let path_buf = PathBuf::from(&path);
        GitService::commit(&path_buf, &msg, stageAll, files)
    })
    .await;

    match result {
        Ok(inner_result) => inner_result.map_err(GitError::from),
        Err(e) => Err(GitError {
            code: "GIT_ERROR".to_string(),
            message: "任务执行失败".to_string(),
            details: Some(format!("Join error: {}", e)),
        }),
    }
}

/// 暂存文件
#[tauri::command]
pub fn git_stage_file(workspacePath: String, filePath: String) -> Result<(), GitError> {
    eprintln!("[Tauri Command] git_stage_file 被调用，workspace_path: {}, file_path: {}", workspacePath, filePath);
    let path = PathBuf::from(workspacePath);
    GitService::stage_file(&path, &filePath).map_err(GitError::from)
}

/// 取消暂存文件
#[tauri::command]
pub fn git_unstage_file(workspacePath: String, filePath: String) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::unstage_file(&path, &filePath).map_err(GitError::from)
}

/// 丢弃工作区变更
#[tauri::command]
pub fn git_discard_changes(workspacePath: String, filePath: String) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::discard_changes(&path, &filePath).map_err(GitError::from)
}

/// 获取远程仓库
#[tauri::command]
pub fn git_get_remotes(workspacePath: String) -> Result<Vec<GitRemote>, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::get_remotes(&path).map_err(GitError::from)
}

/// 添加远程仓库
#[tauri::command]
pub fn git_add_remote(
    workspacePath: String,
    name: String,
    url: String,
) -> Result<GitRemote, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::add_remote(&path, &name, &url).map_err(GitError::from)
}

/// 删除远程仓库
#[tauri::command]
pub fn git_remove_remote(workspacePath: String, name: String) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::delete_remote(&path, &name).map_err(GitError::from)
}

/// 检测 Git Host 类型
#[tauri::command]
pub fn git_detect_host(remoteUrl: String) -> GitHostType {
    GitService::detect_git_host(&remoteUrl)
}

/// 测试命令 - 验证参数序列化
#[tauri::command]
pub fn test_param_serialization(test_param: String) -> String {
    eprintln!("[Test Command] 接收到参数: {}", test_param);
    format!("收到参数: {}", test_param)
}

/// 推送分支到远程
#[tauri::command]
pub fn git_push_branch(
    workspacePath: String,
    branchName: String,
    remoteName: String,
    force: bool,
) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::push_branch(&path, &branchName, &remoteName, force).map_err(GitError::from)
}

/// 推送分支并设置上游
#[tauri::command]
pub fn git_push_set_upstream(
    workspacePath: String,
    branchName: String,
    remoteName: String,
) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::push_set_upstream(&path, &branchName, &remoteName).map_err(GitError::from)
}

/// 拉取远程更新
#[tauri::command]
pub async fn git_pull(
    workspacePath: String,
    remoteName: Option<String>,
    branchName: Option<String>,
) -> Result<GitPullResult, GitError> {
    let remote = remoteName.unwrap_or_else(|| "origin".to_string());
    let path = workspacePath.clone();
    let branch = branchName.clone();

    let result = tokio::task::spawn_blocking(move || {
        let path_buf = PathBuf::from(&path);
        GitService::pull(&path_buf, &remote, branch.as_deref())
    })
    .await;

    match result {
        Ok(inner_result) => inner_result.map_err(GitError::from),
        Err(e) => Err(GitError {
            code: "GIT_ERROR".to_string(),
            message: "Pull task failed".to_string(),
            details: Some(format!("Join error: {}", e)),
        }),
    }
}

/// 获取提交历史
#[tauri::command]
pub fn git_get_log(
    workspacePath: String,
    limit: Option<usize>,
    skip: Option<usize>,
    branch: Option<String>,
) -> Result<Vec<GitCommit>, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::get_log(&path, limit, skip, branch.as_deref()).map_err(GitError::from)
}

/// 批量暂存文件
#[tauri::command]
pub fn git_batch_stage(
    workspacePath: String,
    filePaths: Vec<String>,
) -> Result<BatchStageResult, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::batch_stage(&path, &filePaths).map_err(GitError::from)
}

/// 保存 Stash
#[tauri::command]
pub fn git_stash_save(
    workspacePath: String,
    message: Option<String>,
    includeUntracked: bool,
) -> Result<String, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::stash_save(&path, message.as_deref(), includeUntracked).map_err(GitError::from)
}

/// 获取 Stash 列表
#[tauri::command]
pub fn git_stash_list(workspacePath: String) -> Result<Vec<GitStashEntry>, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::stash_list(&path).map_err(GitError::from)
}

/// 应用 Stash
#[tauri::command]
pub fn git_stash_pop(
    workspacePath: String,
    index: Option<usize>,
) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::stash_pop(&path, index).map_err(GitError::from)
}

/// 删除 Stash
#[tauri::command]
pub fn git_stash_drop(
    workspacePath: String,
    index: usize,
) -> Result<(), GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::stash_drop(&path, index).map_err(GitError::from)
}

/// 创建 Pull Request
#[tauri::command]
pub fn git_create_pr(
    workspacePath: String,
    options: CreatePROptions,
) -> Result<PullRequest, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::create_pr(&path, &options).map_err(GitError::from)
}

/// 获取 PR 状态
#[tauri::command]
pub fn git_get_pr_status(
    workspacePath: String,
    prNumber: u64,
) -> Result<PullRequest, GitError> {
    let path = PathBuf::from(workspacePath);
    GitService::get_pr_status(&path, prNumber).map_err(GitError::from)
}

/// 写入文件内容（用于撤销 AI 修改）
#[tauri::command]
pub fn write_file_absolute(path: String, content: String) -> Result<(), GitError> {
    use std::io::Write;
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
#[tauri::command]
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

