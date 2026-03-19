/*! Git 服务模块
 *
 * 提供统一的 Git 操作 API，内部按功能拆分为多个子模块
 */

// 子模块
mod utils;
mod executor;
mod status;
mod diff;
mod branch;
mod tag;
mod rebase;
mod cherry_pick;
mod revert;
mod commit;
mod remote;
mod log;
mod stash;
mod gitignore;

// 重导出公共 API
pub use executor::{init_repository, is_repository};
pub use status::get_status;
pub use diff::{
    get_diff, get_worktree_diff, get_index_diff, get_worktree_file_diff,
    get_index_file_diff,
};
pub use branch::{get_branches, create_branch, checkout_branch, delete_branch, rename_branch, merge_branch};
pub use tag::{get_tags, create_tag, delete_tag};
pub use rebase::{rebase_branch, rebase_abort, rebase_continue};
pub use cherry_pick::{cherry_pick, cherry_pick_abort, cherry_pick_continue};
pub use revert::{revert, revert_abort, revert_continue};
pub use commit::{commit, stage_file, unstage_file, discard_changes, batch_stage};
pub use remote::{
    get_remotes, detect_git_host, add_remote, delete_remote,
    push_branch, push_set_upstream, create_pr, get_pr_status, pull,
};
pub use log::{get_log, blame_file};
pub use stash::{stash_save, stash_list, stash_pop, stash_drop};
pub use gitignore::{get_gitignore, save_gitignore, add_to_gitignore, get_gitignore_templates};

use std::path::Path;

use crate::models::git::{
    BatchStageResult, CreatePROptions, GitBlameResult, GitBranch, GitCherryPickResult,
    GitCommit, GitDiffEntry, GitIgnoreResult, GitIgnoreTemplate, GitMergeResult, GitPullResult,
    GitRebaseResult, GitRemote, GitRepositoryStatus, GitRevertResult, GitStashEntry, GitTag,
    GitServiceError, PullRequest,
};

/// Git 服务
///
/// 提供统一的 Git 操作接口。所有方法都是静态方法，
/// 通过模块函数实现，保持与原有 API 的兼容性。
pub struct GitService;

impl GitService {
    // ========================================================================
    // 仓库操作
    // ========================================================================

    /// 检查路径是否为 Git 仓库
    pub fn is_repository(path: &Path) -> bool {
        is_repository(path)
    }

    /// 初始化 Git 仓库
    pub fn init_repository(path: &Path, initial_branch: Option<&str>) -> Result<String, GitServiceError> {
        init_repository(path, initial_branch)
    }

    // ========================================================================
    // 状态查询
    // ========================================================================

    /// 获取仓库状态
    pub fn get_status(path: &Path) -> Result<GitRepositoryStatus, GitServiceError> {
        get_status(path)
    }

    // ========================================================================
    // Diff 操作
    // ========================================================================

    /// 获取 Diff（HEAD vs 指定 commit）
    pub fn get_diff(path: &Path, base_commit: &str) -> Result<Vec<GitDiffEntry>, GitServiceError> {
        get_diff(path, base_commit)
    }

    /// 获取工作区 Diff（未暂存的变更）
    pub fn get_worktree_diff(path: &Path) -> Result<Vec<GitDiffEntry>, GitServiceError> {
        get_worktree_diff(path)
    }

    /// 获取暂存区 Diff（已暂存的变更）
    pub fn get_index_diff(path: &Path) -> Result<Vec<GitDiffEntry>, GitServiceError> {
        get_index_diff(path)
    }

    /// 获取单个文件在工作区的 Diff
    pub fn get_worktree_file_diff(path: &Path, file_path: &str) -> Result<GitDiffEntry, GitServiceError> {
        get_worktree_file_diff(path, file_path)
    }

    /// 获取单个文件在暂存区的 Diff
    pub fn get_index_file_diff(path: &Path, file_path: &str) -> Result<GitDiffEntry, GitServiceError> {
        get_index_file_diff(path, file_path)
    }

    // ========================================================================
    // 分支操作
    // ========================================================================

    /// 获取所有分支
    pub fn get_branches(path: &Path) -> Result<Vec<GitBranch>, GitServiceError> {
        get_branches(path)
    }

    /// 创建分支
    pub fn create_branch(path: &Path, name: &str, checkout: bool) -> Result<(), GitServiceError> {
        create_branch(path, name, checkout)
    }

    /// 切换分支
    pub fn checkout_branch(path: &Path, name: &str) -> Result<(), GitServiceError> {
        checkout_branch(path, name)
    }

    /// 删除分支
    pub fn delete_branch(path: &Path, name: &str, force: bool) -> Result<(), GitServiceError> {
        delete_branch(path, name, force)
    }

    /// 重命名分支
    pub fn rename_branch(path: &Path, old_name: &str, new_name: &str) -> Result<(), GitServiceError> {
        rename_branch(path, old_name, new_name)
    }

    /// 合并分支
    pub fn merge_branch(path: &Path, source_branch: &str, no_ff: bool) -> Result<GitMergeResult, GitServiceError> {
        merge_branch(path, source_branch, no_ff)
    }

    // ========================================================================
    // 标签操作
    // ========================================================================

    /// 获取所有标签
    pub fn get_tags(path: &Path) -> Result<Vec<GitTag>, GitServiceError> {
        get_tags(path)
    }

    /// 创建标签
    pub fn create_tag(
        path: &Path,
        name: &str,
        commitish: Option<&str>,
        message: Option<&str>,
    ) -> Result<GitTag, GitServiceError> {
        create_tag(path, name, commitish, message)
    }

    /// 删除标签
    pub fn delete_tag(path: &Path, name: &str) -> Result<(), GitServiceError> {
        delete_tag(path, name)
    }

    // ========================================================================
    // Rebase 操作
    // ========================================================================

    /// 变基分支
    pub fn rebase_branch(path: &Path, source_branch: &str) -> Result<GitRebaseResult, GitServiceError> {
        rebase_branch(path, source_branch)
    }

    /// 中止变基
    pub fn rebase_abort(path: &Path) -> Result<(), GitServiceError> {
        rebase_abort(path)
    }

    /// 继续变基
    pub fn rebase_continue(path: &Path) -> Result<GitRebaseResult, GitServiceError> {
        rebase_continue(path)
    }

    // ========================================================================
    // Cherry-pick 操作
    // ========================================================================

    /// Cherry-pick 提交
    pub fn cherry_pick(path: &Path, commit_sha: &str) -> Result<GitCherryPickResult, GitServiceError> {
        cherry_pick(path, commit_sha)
    }

    /// 中止 Cherry-pick
    pub fn cherry_pick_abort(path: &Path) -> Result<(), GitServiceError> {
        cherry_pick_abort(path)
    }

    /// 继续 Cherry-pick
    pub fn cherry_pick_continue(path: &Path) -> Result<GitCherryPickResult, GitServiceError> {
        cherry_pick_continue(path)
    }

    // ========================================================================
    // Revert 操作
    // ========================================================================

    /// Revert 提交
    pub fn revert(path: &Path, commit_sha: &str) -> Result<GitRevertResult, GitServiceError> {
        revert(path, commit_sha)
    }

    /// 中止 Revert
    pub fn revert_abort(path: &Path) -> Result<(), GitServiceError> {
        revert_abort(path)
    }

    /// 继续 Revert
    pub fn revert_continue(path: &Path) -> Result<GitRevertResult, GitServiceError> {
        revert_continue(path)
    }

    // ========================================================================
    // 提交操作
    // ========================================================================

    /// 提交变更
    pub fn commit(
        path: &Path,
        message: &str,
        stage_all: bool,
        selected_files: Option<Vec<String>>,
    ) -> Result<String, GitServiceError> {
        commit(path, message, stage_all, selected_files)
    }

    /// 暂存文件
    pub fn stage_file(path: &Path, file_path: &str) -> Result<(), GitServiceError> {
        stage_file(path, file_path)
    }

    /// 取消暂存文件
    pub fn unstage_file(path: &Path, file_path: &str) -> Result<(), GitServiceError> {
        unstage_file(path, file_path)
    }

    /// 丢弃工作区变更
    pub fn discard_changes(path: &Path, file_path: &str) -> Result<(), GitServiceError> {
        discard_changes(path, file_path)
    }

    /// 批量暂存文件
    pub fn batch_stage(path: &Path, file_paths: &[String]) -> Result<BatchStageResult, GitServiceError> {
        batch_stage(path, file_paths)
    }

    // ========================================================================
    // 远程操作
    // ========================================================================

    /// 获取远程仓库
    pub fn get_remotes(path: &Path) -> Result<Vec<GitRemote>, GitServiceError> {
        get_remotes(path)
    }

    /// 检测 Git Host 类型
    pub fn detect_git_host(remote_url: &str) -> crate::models::git::GitHostType {
        detect_git_host(remote_url)
    }

    /// 添加远程仓库
    pub fn add_remote(path: &Path, name: &str, url: &str) -> Result<GitRemote, GitServiceError> {
        add_remote(path, name, url)
    }

    /// 删除远程仓库
    pub fn delete_remote(path: &Path, name: &str) -> Result<(), GitServiceError> {
        delete_remote(path, name)
    }

    /// 推送分支到远程
    pub fn push_branch(
        path: &Path,
        branch_name: &str,
        remote_name: &str,
        force: bool,
    ) -> Result<(), GitServiceError> {
        push_branch(path, branch_name, remote_name, force)
    }

    /// 推送分支并设置上游
    pub fn push_set_upstream(
        path: &Path,
        branch_name: &str,
        remote_name: &str,
    ) -> Result<(), GitServiceError> {
        push_set_upstream(path, branch_name, remote_name)
    }

    /// 创建 Pull Request
    pub fn create_pr(path: &Path, options: &CreatePROptions) -> Result<PullRequest, GitServiceError> {
        create_pr(path, options)
    }

    /// 获取 PR 状态
    pub fn get_pr_status(path: &Path, pr_number: u64) -> Result<PullRequest, GitServiceError> {
        get_pr_status(path, pr_number)
    }

    /// Pull 远程更新
    pub fn pull(
        path: &Path,
        remote_name: &str,
        branch_name: Option<&str>,
    ) -> Result<GitPullResult, GitServiceError> {
        pull(path, remote_name, branch_name)
    }

    // ========================================================================
    // 日志和 Blame 操作
    // ========================================================================

    /// 获取提交历史
    pub fn get_log(
        path: &Path,
        limit: Option<usize>,
        skip: Option<usize>,
        branch: Option<&str>,
    ) -> Result<Vec<GitCommit>, GitServiceError> {
        get_log(path, limit, skip, branch)
    }

    /// 获取文件 Blame 信息
    pub fn blame_file(path: &Path, file_path: &str) -> Result<GitBlameResult, GitServiceError> {
        blame_file(path, file_path)
    }

    // ========================================================================
    // Stash 操作
    // ========================================================================

    /// 保存 Stash
    pub fn stash_save(
        path: &Path,
        message: Option<&str>,
        include_untracked: bool,
    ) -> Result<String, GitServiceError> {
        stash_save(path, message, include_untracked)
    }

    /// 获取 Stash 列表
    pub fn stash_list(path: &Path) -> Result<Vec<GitStashEntry>, GitServiceError> {
        stash_list(path)
    }

    /// 应用 Stash
    pub fn stash_pop(path: &Path, index: Option<usize>) -> Result<(), GitServiceError> {
        stash_pop(path, index)
    }

    /// 删除 Stash
    pub fn stash_drop(path: &Path, index: usize) -> Result<(), GitServiceError> {
        stash_drop(path, index)
    }

    // ========================================================================
    // .gitignore 管理
    // ========================================================================

    /// 获取 .gitignore 文件内容
    pub fn get_gitignore(path: &Path) -> Result<GitIgnoreResult, GitServiceError> {
        get_gitignore(path)
    }

    /// 保存 .gitignore 文件内容
    pub fn save_gitignore(path: &Path, content: &str) -> Result<(), GitServiceError> {
        save_gitignore(path, content)
    }

    /// 添加忽略规则到 .gitignore
    pub fn add_to_gitignore(path: &Path, rules: &[String]) -> Result<(), GitServiceError> {
        add_to_gitignore(path, rules)
    }

    /// 获取常用忽略规则模板
    pub fn get_gitignore_templates() -> Vec<GitIgnoreTemplate> {
        get_gitignore_templates()
    }
}
