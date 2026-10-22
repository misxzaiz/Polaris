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
mod reset;
mod gitignore;
mod reflog;
mod undo;
mod conflict;
mod sequence;
mod lane_cache;
mod risk_scan;

// 重导出公共 API
pub use executor::{init_repository, is_repository, discover_repositories};
pub use status::get_status;
pub use diff::{
    get_diff, get_worktree_diff, get_index_diff, get_worktree_file_diff,
    get_index_file_diff,
};
pub use branch::{get_branches, create_branch, checkout_branch, delete_branch, rename_branch, merge_branch, checkout_commit};
pub use tag::{get_tags, create_tag, delete_tag};
pub use rebase::{
    rebase_branch, rebase_abort, rebase_continue,
    plan_interactive_rebase, start_interactive_rebase, suggest_rebase_todos,
};
pub use cherry_pick::{cherry_pick, cherry_pick_abort, cherry_pick_continue};
pub use revert::{revert, revert_abort, revert_continue};
pub use commit::{commit, amend_commit, stage_file, unstage_file, discard_changes, batch_stage, batch_unstage, batch_discard, commit_group};
pub use remote::{
    get_remotes, detect_git_host, add_remote, delete_remote,
    push_branch, push_set_upstream, create_pr, get_pr_status, pull, fetch,
};
pub use log::{get_log, get_log_with_lanes, search_log, get_commit_details, get_file_history, blame_file};
pub use stash::{stash_save, stash_list, stash_pop, stash_drop, stash_apply, stash_show};
pub use risk_scan::scan_commit_risk;
pub use reset::{reset, ResetMode};
pub use gitignore::{get_gitignore, save_gitignore, add_to_gitignore, get_gitignore_templates};
pub use reflog::get_reflog;
pub use undo::{create_undo_snapshot, drop_undo_snapshot, list_undo_snapshots, prune_undo_snapshots, restore_undo_snapshot};
pub use conflict::predict_conflicts;
pub use sequence::{
    get_sequence_state, guard_no_sequence, stage_conflicted_files, resolve_conflict_file,
    ConflictFileResolution, ConflictSide,
};

use std::path::Path;

use crate::models::git::{
    BatchOpResult, BatchStageResult, CreatePROptions, GitBlameResult, GitBranch, GitCherryPickResult,
    GitCommit, GitCommitDetails, GitConflictPrediction, GitDiffEntry, GitDiscoveredRepo, GitFileHistoryEntry, GitIgnoreResult,
    GitIgnoreTemplate, GitLogPage, GitMergeResult, GitPullResult, GitCommitRiskReport, GitRebasePlan, GitRebaseSuggestion, GitRebaseResult,
    GitRebaseTodoItem, GitReflogEntry, GitRemote,
    GitRepositoryStatus, GitRevertResult, GitServiceError, GitStashEntry, GitTag, GitSequenceState,
    LogSearchFilter,
    PullRequest,
    UndoRestoreOutcome, UndoSnapshotMeta,
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

    /// 扫描根目录下所有嵌套 Git 仓库（聚合工作区场景）
    pub fn discover_repositories(root: &Path, max_depth: usize) -> Result<Vec<GitDiscoveredRepo>, GitServiceError> {
        discover_repositories(root, max_depth)
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
    pub fn get_diff(path: &Path, base_commit: &str, target_commit: Option<&str>) -> Result<Vec<GitDiffEntry>, GitServiceError> {
        get_diff(path, base_commit, target_commit)
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
    pub fn create_branch(path: &Path, name: &str, checkout: bool, start_point: Option<&str>) -> Result<(), GitServiceError> {
        create_branch(path, name, checkout, start_point)
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

    /// 检出指定提交（detached HEAD）
    pub fn checkout_commit(path: &Path, commit_sha: &str) -> Result<(), GitServiceError> {
        checkout_commit(path, commit_sha)
    }

    /// Reset HEAD
    pub fn reset(path: &Path, commit_sha: &str, mode: ResetMode) -> Result<(), GitServiceError> {
        reset(path, commit_sha, mode)
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

    /// 面板化 Interactive Rebase 预览计划（只读；base..HEAD 应用序）
    pub fn plan_interactive_rebase(
        path: &Path,
        base_commitish: &str,
    ) -> Result<GitRebasePlan, GitServiceError> {
        plan_interactive_rebase(path, base_commitish)
    }

    /// 执行面板化 Interactive Rebase（GIT_SEQUENCE_EDITOR 注入面板 todo；写类）
    pub fn start_interactive_rebase(
        path: &Path,
        base_commitish: &str,
        todos: &[GitRebaseTodoItem],
        autosquash: bool,
    ) -> Result<GitRebaseResult, GitServiceError> {
        start_interactive_rebase(path, base_commitish, todos, autosquash)
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

    /// 批量取消暂存文件
    pub fn batch_unstage(path: &Path, file_paths: &[String]) -> Result<BatchOpResult, GitServiceError> {
        batch_unstage(path, file_paths)
    }

    /// 批量丢弃工作区变更
    pub fn batch_discard(path: &Path, file_paths: &[String]) -> Result<BatchOpResult, GitServiceError> {
        batch_discard(path, file_paths)
    }

    /// 按组原子提交（AI-2：只提交组内文件，index 其它已暂存内容不受影响，等价 `git commit <paths>`）
    pub fn commit_group(path: &Path, message: &str, files: &[String]) -> Result<String, GitServiceError> {
        commit_group(path, message, files)
    }

    // ========================================================================
    // Undo 网络（FR-P2-3：危险操作快照 + 一键恢复）
    // ========================================================================

    /// 为 workspace 创建撤销快照（危险操作前自动调用）
    pub fn create_undo_snapshot(
        path: &Path,
        context: &str,
        extra_refs: &[String],
    ) -> Result<String, GitServiceError> {
        create_undo_snapshot(path, context, extra_refs)
    }

    /// 列出某 workspace 的全部快照（倒序按时间）
    pub fn list_undo_snapshots(path: &Path) -> Result<Vec<UndoSnapshotMeta>, GitServiceError> {
        list_undo_snapshots(path)
    }

    /// 恢复指定快照（前端「撤销」按钮）
    pub fn restore_undo_snapshot(
        path: &Path,
        snapshot_ref: &str,
    ) -> Result<UndoRestoreOutcome, GitServiceError> {
        restore_undo_snapshot(path, snapshot_ref)
    }

    /// 删除指定快照（前端手动清理）
    pub fn drop_undo_snapshot(path: &Path, snapshot_ref: &str) -> Result<(), GitServiceError> {
        drop_undo_snapshot(path, snapshot_ref)
    }

    /// 按保留策略清理：每 ws 最多保留 N 个最近快照
    pub fn prune_undo_snapshots(path: &Path, max_keep: usize) -> Result<usize, GitServiceError> {
        prune_undo_snapshots(path, max_keep)
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

    /// 推送分支到远程（P1：force-with-lease 安全化 —— force 一律走 lease，裸 --force 除名）
    pub fn push_branch(
        path: &Path,
        branch_name: &str,
        remote_name: &str,
        force: bool,
        remote_branch_name: Option<&str>,
        lease: Option<&str>,
    ) -> Result<(), GitServiceError> {
        push_branch(path, branch_name, remote_name, force, remote_branch_name, lease)
    }

    /// 拉取远程更新（fetch —— 不合并；auto-fetch 调度默认关 = 前端设置项）
    pub fn fetch(path: &Path, remote_name: Option<&str>, prune: bool) -> Result<String, GitServiceError> {
        fetch(path, remote_name, prune)
    }

    /// 推送分支并设置上游
    pub fn push_set_upstream(
        path: &Path,
        branch_name: &str,
        remote_name: &str,
        remote_branch_name: Option<&str>,
    ) -> Result<(), GitServiceError> {
        push_set_upstream(path, branch_name, remote_name, remote_branch_name)
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

    /// 泳道图分页查询（P2）—— commits（含 refs 装饰）+ rows（lane 数据）一次返回
    pub fn get_log_with_lanes(
        path: &Path,
        limit: Option<usize>,
        skip: Option<usize>,
        branch: Option<&str>,
    ) -> Result<GitLogPage, GitServiceError> {
        get_log_with_lanes(path, limit, skip, branch)
    }

    /// 提交历史搜索（P1：log 搜索 —— grep/author/pickaxe/since/范围）
    pub fn search_log(
        path: &Path,
        filter: &LogSearchFilter,
        limit: Option<usize>,
        skip: Option<usize>,
    ) -> Result<Vec<GitCommit>, GitServiceError> {
        search_log(path, filter, limit, skip)
    }

    /// 读取 reflog（P1：reflog UI + 一键恢复的地基）
    pub fn get_reflog(
        path: &Path,
        branch: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<GitReflogEntry>, GitServiceError> {
        get_reflog(path, branch, limit)
    }

    /// Amend HEAD（P1；任意历史 commit amend 依赖 P3 interactive rebase）
    pub fn amend_commit(
        path: &Path,
        message: Option<&str>,
        stage_all: bool,
        selected_files: Option<Vec<String>>,
    ) -> Result<String, GitServiceError> {
        amend_commit(path, message, stage_all, selected_files)
    }

    /// 获取单个提交详情
    pub fn get_commit_details(
        path: &Path,
        commit_sha: &str,
    ) -> Result<GitCommitDetails, GitServiceError> {
        get_commit_details(path, commit_sha)
    }

    /// 获取单文件提交历史
    pub fn get_file_history(
        path: &Path,
        file_path: &str,
        limit: Option<usize>,
        skip: Option<usize>,
        branch: Option<&str>,
    ) -> Result<Vec<GitFileHistoryEntry>, GitServiceError> {
        get_file_history(path, file_path, limit, skip, branch)
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

    /// 应用 Stash（保留 stash，不 drop —— P1 parity：与 IDEA apply 对齐）
    pub fn stash_apply(path: &Path, index: Option<usize>) -> Result<(), GitServiceError> {
        stash_apply(path, index)
    }

    /// 查看 Stash patch 内容（P1）
    pub fn stash_show(path: &Path, index: Option<usize>) -> Result<String, GitServiceError> {
        stash_show(path, index)
    }

    /// 提交前风险扫描（P3 AI-3；只读，纯本地）
    pub fn scan_commit_risk(path: &Path) -> Result<GitCommitRiskReport, GitServiceError> {
        scan_commit_risk(path)
    }

    /// AI-8：fixup!/squash! 整理建议（只读，纯本地）
    pub fn suggest_rebase_todos(path: &Path, base_commitish: &str) -> Result<GitRebaseSuggestion, GitServiceError> {
        suggest_rebase_todos(path, base_commitish)
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

    // ========================================================================
    // 冲突预测（FR-P2-AI4）
    // ========================================================================

    /// 冲突预测：对方 ahead commits 涉及的文件 ∩ 本地 modified → 风险清单（确定性计算，0 token）
    pub fn predict_conflicts(
        path: &Path,
        branch: Option<&str>,
    ) -> Result<GitConflictPrediction, GitServiceError> {
        predict_conflicts(path, branch)
    }

    // ========================================================================
    // 序列操作机（P3：merge/rebase/cherry-pick/revert 四合一状态探测）
    // ========================================================================

    /// 归一读取当前序列操作状态（C11：kind + 冲突条目 + rebase 步数，只读）
    pub fn get_sequence_state(
        path: &Path,
    ) -> Result<GitSequenceState, GitServiceError> {
        get_sequence_state(path)
    }

    /// 交叉守卫：任何序列操作进行中即报对应 InProgress（C11，替代只查 has_conflicts）
    pub fn guard_no_sequence(path: &Path) -> Result<(), GitServiceError> {
        guard_no_sequence(path)
    }

    /// 冲突文件全部 add 进 index（解决后直落 staging；删除冲突跳过）
    pub fn stage_conflicted_files(path: &Path) -> Result<Vec<String>, GitServiceError> {
        stage_conflicted_files(path)
    }

    /// 解决单个冲突文件（三态：写内容 / 还原某侧 stage / 接受删除，直落 staging）
    pub fn resolve_conflict_file(
        path: &Path,
        file_path: &str,
        op: ConflictFileResolution,
    ) -> Result<(), GitServiceError> {
        resolve_conflict_file(path, file_path, op)
    }
}
