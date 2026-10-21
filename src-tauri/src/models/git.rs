/*! Git 数据模型
 *
 * Rust 端的 Git 相关数据结构定义
 */

use serde::{Deserialize, Serialize};
use thiserror::Error;

// ============================================================================
// Git 文件状态
// ============================================================================

/// Git 文件状态枚举
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitFileStatus {
    Untracked,
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Unmerged,
}

impl From<git2::Status> for GitFileStatus {
    fn from(status: git2::Status) -> Self {
        if status.is_index_new()
            || status.is_index_modified()
            || status.is_index_deleted()
            || status.is_index_renamed()
        {
            match (
                status.is_index_new(),
                status.is_index_deleted(),
                status.is_index_renamed(),
            ) {
                (true, false, false) => GitFileStatus::Added,
                (false, true, false) => GitFileStatus::Deleted,
                (_, _, true) => GitFileStatus::Renamed,
                _ => GitFileStatus::Modified,
            }
        } else if status.is_wt_new() {
            GitFileStatus::Untracked
        } else if status.is_wt_deleted() {
            GitFileStatus::Deleted
        } else if status.is_wt_renamed() {
            GitFileStatus::Renamed
        } else if status.is_wt_modified() {
            GitFileStatus::Modified
        } else if status.is_conflicted() {
            GitFileStatus::Unmerged
        } else {
            GitFileStatus::Modified
        }
    }
}

/// Git 文件变更信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileChange {
    pub path: String,
    pub status: GitFileStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,
}

// ============================================================================
// Git 仓库状态
// ============================================================================

/// Git 仓库完整状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct GitRepositoryStatus {
    pub exists: bool,
    pub branch: String,
    pub commit: String,
    pub short_commit: String,
    pub ahead: usize,
    pub behind: usize,
    pub staged: Vec<GitFileChange>,
    pub unstaged: Vec<GitFileChange>,
    pub untracked: Vec<String>,
    pub conflicted: Vec<String>,
    pub is_empty: bool,
}


// ============================================================================
// Git Diff
// ============================================================================

/// Diff 变更类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiffChangeType {
    Added,
    Deleted,
    Modified,
    Renamed,
    Copied,
}

/// Git Diff 状态提示
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDiffStatusHint {
    pub has_conflict: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub current_view: String,
}

/// Git Diff 条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDiffEntry {
    pub file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_file_path: Option<String>,
    pub change_type: DiffChangeType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,
    pub is_binary: bool,
    /// 内容是否被省略（true = 至少有一方内容因文件过大而省略）
    /// 注意：新增文件的 old_content 为 None 不是省略，删除文件的 new_content 为 None 也不是省略
    /// 真正的省略是指：文件存在但内容太大无法显示
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_omitted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_hint: Option<GitDiffStatusHint>,
}

// ============================================================================
// Git 提交
// ============================================================================

/// Git 提交信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub sha: String,
    pub short_sha: String,
    pub message: String,
    pub author: String,
    pub author_email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    pub parents: Vec<String>,
    /// 该提交上的 refs 装饰（泳道图三色 + 标记）。缺省空数组。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<GitCommitRef>,
}

/// 提交上的 refs 装饰（泳道图用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRef {
    /// 显示名（如 main、origin/main、HEAD、v1.0）
    pub name: String,
    /// 分类：HEAD / 本地分支 / 远程分支 / tag
    pub kind: String,
    /// ref 全名（refs/heads/main 等）
    pub target: String,
}

/// 泳道格子：该 commit 在泳道列位置的绘制原语
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLaneCell {
    /// 泳道下标
    pub lane: usize,
    /// 节点类型：commit / merge / empty / none
    pub node: String,
    /// 下行边（连到下一行同泳道或换行）
    pub edge_down: Option<usize>,
    /// 上行边（连到上一行不同泳道，即换行汇入）
    pub edge_up: Option<usize>,
}

/// 单条泳道行（每 commit 一行）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLaneRow {
    pub sha: String,
    pub cells: Vec<GitLaneCell>,
    /// 冗余带 refs，前端不必再查
    pub refs: Vec<GitCommitRef>,
}

/// 单行语义色（P2 增量：泳道图语义着色的服务端预计算）
///
/// 四态见 spec `plans/git-panel-p2-lane-increment-spec.md`：
/// - "local"    —— 当前分支内、与远程已同步的本地提交（绿）
/// - "unpushed" —— 当前分支内、任何远程不可达的提交（红，未 push）
/// - "merged"   —— 已并入主干（main 可达）的历史提交（蓝灰）
/// - "dim"      —— 当前分支不可达 / 陈旧孤立提交（灰暗）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitLaneSemantic {
    pub kind: String,
}

/// 泳道图分页结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogPage {
    pub commits: Vec<GitCommit>,
    pub rows: Vec<GitLaneRow>,
    /// P2 增量：每行语义色，与 commits 一一对应；缺省空数组 = 旧实现/旧前端兼容
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub semantic: Vec<GitLaneSemantic>,
}

/// Git 提交详情
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetails {
    pub commit: GitCommit,
    pub files: Vec<GitDiffEntry>,
    pub total_additions: usize,
    pub total_deletions: usize,
}

/// 单文件提交历史条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileHistoryEntry {
    pub commit: GitCommit,
    pub file: GitDiffEntry,
}

// ============================================================================
// Git 分支
// ============================================================================

/// Git 分支信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub commit: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_commit_date: Option<i64>,
}

// ============================================================================
// Git 标签
// ============================================================================

/// Git 标签信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTag {
    /// 标签名称
    pub name: String,
    /// 是否为附注标签
    pub is_annotated: bool,
    /// 标签对应的提交 SHA
    pub commit_sha: String,
    /// 短 SHA
    pub short_sha: String,
    /// 标签消息（仅附注标签）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// 标签创建者（仅附注标签）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tagger: Option<String>,
    /// 标签创建时间（仅附注标签）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
}

// ============================================================================
// Git Blame
// ============================================================================

/// Git Blame 单行信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameLine {
    /// 行号（从 1 开始）
    pub line_number: usize,
    /// 该行在原提交中的行号
    pub original_line_number: usize,
    /// 提交 SHA
    pub commit_sha: String,
    /// 短 SHA
    pub short_sha: String,
    /// 作者名称
    pub author: String,
    /// 作者邮箱
    pub author_email: String,
    /// 提交时间（Unix 时间戳）
    pub timestamp: i64,
    /// 提交消息（第一行）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// 文件内容
    pub content: String,
}

/// Git Blame 结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameResult {
    /// 文件路径
    pub file_path: String,
    /// Blame 行信息列表
    pub lines: Vec<GitBlameLine>,
    /// 总行数
    pub total_lines: usize,
}

// ============================================================================
// Git 远程仓库
// ============================================================================

/// Git 远程仓库信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRemote {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetch_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub push_url: Option<String>,
}

// ============================================================================
// Pull Request
// ============================================================================

/// PR 状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PRState {
    Open,
    Merged,
    Closed,
}

/// PR 审查状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PRReviewStatus {
    Approved,
    ChangesRequested,
    Pending,
    Commented,
}

/// Pull Request 信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub state: PRState,
    pub head_branch: String,
    pub base_branch: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<i64>,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_status: Option<PRReviewStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_files: Option<usize>,
}

/// PR 创建选项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePROptions {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub head_branch: String,
    pub base_branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignees: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
}

// ============================================================================
// Git Host
// ============================================================================

/// Git Host 类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitHostType {
    GitHub,
    GitLab,
    AzureDevOps,
    Bitbucket,
    Unknown,
}

// ============================================================================
// 错误类型
// ============================================================================

/// Git 操作错误
/// Git 操作错误（返回给前端）
#[derive(Debug, Clone, Serialize, Deserialize, Error)]
#[error("[{code}] {message}")]
pub struct GitError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

/// Git 服务错误（内部使用）
#[allow(dead_code)]
#[derive(Debug, Error)]
pub enum GitServiceError {
    #[error("Git error: {0}")]
    GitError(#[from] git2::Error),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Not a Git repository")]
    NotARepository,
    #[error("Branch '{0}' not found")]
    BranchNotFound(String),
    #[error("Commit '{0}' not found")]
    CommitNotFound(String),
    #[error("Merge conflicts: {message}. Files: {conflicted_files:?}")]
    ConflictsDetected {
        message: String,
        conflicted_files: Vec<String>,
    },
    #[error("Rebase is already in progress")]
    RebaseInProgress,
    #[error("Cherry-pick is already in progress")]
    CherryPickInProgress,
    #[error("Revert is already in progress")]
    RevertInProgress,
    #[error("Merge is already in progress")]
    MergeInProgress,
    #[error("Remote '{0}' not found")]
    RemoteNotFound(String),
    #[error("Remote '{0}' already exists")]
    RemoteExists(String),
    #[error("CLI tool '{0}' not found")]
    CLINotFound(String),
    #[error("CLI error: {0}")]
    CLIError(String),
}

// ============================================================================
// 分支比较
// ============================================================================

/// 分支比较结果（预留功能）
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchComparison {
    pub ahead: usize,
    pub behind: usize,
    pub diverged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub common_ancestor: Option<String>,
}

// ============================================================================
// 冲突域协议（C10：非内容冲突全穿帮修复）
// ============================================================================

/// 冲突 kind（C10：二进制 / delete-modify / rename-delete 不再穿帮）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitConflictKind {
    /// 文本冲突（有 marker 可解析）
    Text,
    /// 二进制冲突（无 marker，只能整文件取舍）
    Binary,
    /// delete/modify：本地删、对方改
    DeletedByUs,
    /// delete/modify：对方删、本地改
    DeletedByThem,
    /// rename/delete
    RenameDelete,
}

/// 单文件冲突条目（C10：merge/rebase/cherry-pick/revert 四结果结构一次改齐）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitConflictEntry {
    pub path: String,
    pub kind: GitConflictKind,
    /// 冲突三方 stage 内容（Text 有内容；Binary 无，可为空）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ours: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theirs: Option<String>,
}

/// 当前进行中的序列操作类型（C11：归一探测）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitSequenceKind {
    None,
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

/// 序列操作状态（C11：Continue 一律从这里回读，不信任 stderr）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSequenceState {
    pub kind: GitSequenceKind,
    pub has_conflicts: bool,
    pub conflicts: Vec<GitConflictEntry>,
    /// rebase 步数（rebase-merge/end + msgnum 回读；merge 等无步数为 None）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_step: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_steps: Option<usize>,
}

// ============================================================================
// Pull 结果
// ============================================================================

/// Pull 操作结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitPullResult {
    pub success: bool,
    pub fast_forward: bool,
    pub pulled_commits: usize,
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
    pub conflicts: Vec<GitConflictEntry>,
}

// ============================================================================
// Merge 结果
// ============================================================================

/// Merge 操作结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitMergeResult {
    /// 是否成功
    pub success: bool,
    /// 是否为快进合并
    pub fast_forward: bool,
    /// 是否有冲突
    pub has_conflicts: bool,
    /// 冲突条目列表（C10 升级：携带 kind + stages）
    pub conflicts: Vec<GitConflictEntry>,
    /// 合并的提交数
    pub merged_commits: usize,
    /// 变更的文件数
    pub files_changed: usize,
}

/// Interactive Rebase 单条 TODO 项（面板化 todo 的最小单元；serde camelCase）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRebaseTodoItem {
    /// 完整 sha
    pub sha: String,
    /// 提交标题（单行）
    pub subject: String,
    /// 面板动作
    /// pick = 保留 / drop = 丢弃 / squash = 合入并保留合并消息 / fixup = 合入丢弃消息
    /// reword = 保留并改写提交消息（经 GIT_EDITOR 脚本按序替换消息文件，见 rebase.rs）
    pub action: GitRebaseTodoAction,
    /// reword 的新提交消息（单行 subject 或多行正文均可；action != Reword 时为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_message: Option<String>,
}

/// TODO 动作枚举（面板 + git inner todo 行共用）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GitRebaseTodoAction {
    Pick,
    Drop,
    Squash,
    Fixup,
    Reword,
}

impl GitRebaseTodoAction {
    /// git todo 行首小写关键字
    pub fn as_keyword(&self) -> &'static str {
        match self {
            GitRebaseTodoAction::Pick => "pick",
            GitRebaseTodoAction::Drop => "drop",
            GitRebaseTodoAction::Squash => "squash",
            GitRebaseTodoAction::Fixup => "fixup",
            GitRebaseTodoAction::Reword => "reword",
        }
    }
}

/// Interactive Rebase 计划（预览/面板编辑的输入；sha 由 base..HEAD 反序生成）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRebasePlan {
    /// 变基起点（面板传回的 base commitish）
    pub base_commitish: String,
    /// 应用序（老 → 新）的 todo 项
    pub commits: Vec<GitRebaseTodoItem>,
    /// 首项（最老）不允许改非 pick（squash/fixup 必须跟随 pick）
    pub first_locked: bool,
}

/// AI-8：fixup!/squash! 整理建议（纯本地启发式，建议序列可直接喂 start_interactive_rebase）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRebaseSuggestion {
    /// 与面板相同的 base commitish
    pub base_commitish: String,
    /// 建议应用序（老 → 新；squash/fixup 已插到目标连段尾部）
    pub commits: Vec<GitRebaseTodoItem>,
    /// 成功配对目标并移动的 fixup!/squash! 条数
    pub moved_count: usize,
    /// 未找到目标（保持原位 pick）的 short sha 列表
    pub unmatched: Vec<String>,
}

/// Rebase 操作结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRebaseResult {
    /// 是否成功
    pub success: bool,
    /// 是否有冲突
    pub has_conflicts: bool,
    /// 冲突条目列表（C10 升级）
    pub conflicts: Vec<GitConflictEntry>,
    /// 变基的提交数
    pub rebased_commits: usize,
    /// 当前步骤（从 1 开始）
    pub current_step: usize,
    /// 总步骤数
    pub total_steps: usize,
    /// 是否已完成
    pub finished: bool,
}

/// Cherry-pick 操作结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCherryPickResult {
    /// 是否成功
    pub success: bool,
    /// 是否有冲突
    pub has_conflicts: bool,
    /// 冲突条目列表（C10 升级）
    pub conflicts: Vec<GitConflictEntry>,
    /// 提交 SHA
    pub commit_sha: String,
    /// 提交消息
    pub commit_message: String,
    /// 是否已完成
    pub finished: bool,
}

/// Revert 操作结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRevertResult {
    /// 是否成功
    pub success: bool,
    /// 是否有冲突
    pub has_conflicts: bool,
    /// 冲突条目列表（C10 升级）
    pub conflicts: Vec<GitConflictEntry>,
    /// 新提交的 SHA（revert 成功后）
    pub commit_sha: String,
    /// 提交消息
    pub commit_message: String,
    /// 是否已完成
    pub finished: bool,
}

// ============================================================================
// 批量暂存结果
// ============================================================================

/// 批量暂存结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchStageResult {
    pub staged: Vec<String>,
    pub failed: Vec<StageFailure>,
    pub total: usize,
}

/// 暂存失败信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageFailure {
    pub path: String,
    pub error: String,
}

// ============================================================================
// Stash
// ============================================================================

/// Stash 条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStashEntry {
    pub index: usize,
    pub message: String,
    pub branch: String,
    pub commit_sha: String,
    pub timestamp: i64,
}

// ============================================================================
// 提交风险扫描（P3 AI-3：PR 式 Review 门，纯本地零 AI）
// ============================================================================

/// 单条风险记录（serde camelCase）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRiskFinding {
    /// 文件路径（repo 相对）
    pub file: String,
    /// 行号（1 起；large-file 类无行号 → None）
    pub line: Option<u32>,
    /// 类别：secret / conflict-marker / large-file
    pub category: String,
    /// secret 命中的模式名（其余类别 None）
    pub pattern: Option<String>,
    /// 摘要/行内容截断（secret 截 60 字符，marker 截 80）
    pub excerpt: String,
}

/// 扫描报告
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRiskReport {
    pub findings: Vec<GitCommitRiskFinding>,
    /// 达 120 条上限截断（真实结果可能更多）
    pub truncated: bool,
}

// ============================================================================
// Reflog（P1：reflog UI + 一键恢复）
// ============================================================================

/// Reflog 条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReflogEntry {
    /// 完整提交 sha（恢复目标 = checkout sha）
    pub sha: String,
    /// 短 sha
    pub short_sha: String,
    /// reflog 选择器（如 HEAD@{0}、refs/heads/main@{3}）
    pub selector: String,
    /// 动作描述（%gs，如 "checkout: moving from a to b"）
    pub subject: String,
    /// Unix 秒
    pub timestamp: i64,
    /// 关联分支名（%gD 无 fname? 简化：selector 含分支时前端解析）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

// ============================================================================
// Log 搜索（P1：log 搜索 + AI-6 参数编译器）
// ============================================================================

/// 提交历史搜索过滤器（对应 CLI git log 的 grep/author/-S/--since 家族）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSearchFilter {
    /// 提交标题匹配（--grep，匹配整条 message；git 多 --grep 为 OR 语义，取单值）
    pub grep: Option<String>,
    /// 作者名（--author，正则）
    pub author: Option<String>,
    /// 代码内容匹配（-S pickaxe），精确出现次数变化
    pub pickaxe: Option<String>,
    /// 路径过滤（--）
    pub path: Option<String>,
    /// 起始时间（--since，如 "2 weeks ago" / "2026-01-01"）
    pub since: Option<String>,
    /// 截止时间（--until）
    pub until: Option<String>,
    /// 分支范围（"a..b" | "a...b" | "main"），push_history_tip 等价的 tip 覆盖
    pub range: Option<String>,
    /// 正则模式开关（--extended-regexp? CLI 默认 basic；git --grep 支持基本正则；E 开关用 --fixed-strings 反向）
    pub fixed_strings: bool,
}

// ============================================================================
// 冲突文件
// ============================================================================

/// 冲突文件信息（预留功能）
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictedFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub our_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub their_content: Option<String>,
    pub resolved: bool,
}

// ============================================================================
// Git 操作结果
// ============================================================================

/// 统一的 Git 操作结果（预留）
#[allow(dead_code)]
pub type GitResult<T> = Result<T, GitError>;

/// 将 GitServiceError 转换为 GitError
impl From<GitServiceError> for GitError {
    fn from(err: GitServiceError) -> Self {
        let (code, message, details) = match err {
            GitServiceError::GitError(e) => (
                "GIT_ERROR".to_string(),
                e.message().to_string(),
                Some(format!("{:?}", e)),
            ),
            GitServiceError::IoError(e) => (
                "IO_ERROR".to_string(),
                e.to_string(),
                None,
            ),
            GitServiceError::NotARepository => (
                "NOT_A_REPOSITORY".to_string(),
                "Path is not a Git repository".to_string(),
                None,
            ),
            GitServiceError::BranchNotFound(name) => (
                "BRANCH_NOT_FOUND".to_string(),
                format!("Branch '{}' not found", name),
                None,
            ),
            GitServiceError::CommitNotFound(sha) => (
                "COMMIT_NOT_FOUND".to_string(),
                format!("Commit '{}' not found", sha),
                None,
            ),
            GitServiceError::ConflictsDetected {
                message,
                conflicted_files,
            } => (
                "CONFLICTS_DETECTED".to_string(),
                message,
                Some(format!("Conflicted files: {:?}", conflicted_files)),
            ),
            GitServiceError::RebaseInProgress => (
                "REBASE_IN_PROGRESS".to_string(),
                "A rebase is already in progress".to_string(),
                None,
            ),
            GitServiceError::CherryPickInProgress => (
                "CHERRY_PICK_IN_PROGRESS".to_string(),
                "A cherry-pick is already in progress".to_string(),
                None,
            ),
            GitServiceError::RevertInProgress => (
                "REVERT_IN_PROGRESS".to_string(),
                "A revert is already in progress".to_string(),
                None,
            ),
            GitServiceError::MergeInProgress => (
                "MERGE_IN_PROGRESS".to_string(),
                "A merge is already in progress".to_string(),
                None,
            ),
            GitServiceError::RemoteNotFound(name) => (
                "REMOTE_NOT_FOUND".to_string(),
                format!("Remote '{}' not found", name),
                None,
            ),
            GitServiceError::RemoteExists(name) => (
                "REMOTE_EXISTS".to_string(),
                format!("Remote '{}' already exists", name),
                None,
            ),
            GitServiceError::CLINotFound(cli) => (
                "CLI_NOT_FOUND".to_string(),
                format!("CLI tool '{}' not found in PATH", cli),
                Some("Please install the CLI tool and ensure it's in your PATH".to_string()),
            ),
            GitServiceError::CLIError(err) => (
                "CLI_ERROR".to_string(),
                err,
                None,
            ),
        };

        Self { code, message, details }
    }
}

// ============================================================================
// .gitignore 管理
// ============================================================================

/// .gitignore 文件信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIgnoreResult {
    /// 文件是否存在
    pub exists: bool,
    /// 文件内容
    pub content: String,
    /// 文件路径（相对于仓库根目录）
    pub path: String,
}

/// 常用忽略规则模板
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitIgnoreTemplate {
    /// 模板名称
    pub name: String,
    /// 模板描述
    pub description: String,
    /// 规则列表
    pub rules: Vec<String>,
}

// ============================================================================
// 仓库发现（聚合工作区场景）
// ============================================================================

/// 扫描到的子仓库信息
///
/// 用于"工作区本身非 git、下含多个并行 git 子项目"的场景。
/// GitPanel 在主仓库打开失败时调用 `git_discover_repositories`，
/// 列出子仓库供用户选择，选中后以该 path 作为 workspacePath 走原有流程。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiscoveredRepo {
    /// 仓库绝对路径
    pub path: String,
    /// 目录名（展示用）
    pub name: String,
    /// 当前分支名（空仓库时为空串）
    pub branch: String,
    /// 短 SHA（空仓库时为空串）
    pub short_commit: String,
    /// 是否为空仓库（无任何提交）
    pub is_empty: bool,
    /// 是否有未提交变更（工作树或索引有改动）
    pub has_changes: bool,
}

// ============================================================================
// Undo 网络（FR-P2-3：危险操作快照 + 一键恢复）
// ============================================================================

/// 撤销快照元数据（前端通知条/快照列表展示）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoSnapshotMeta {
    /// 快照 ref 名（refs/polaris-undo/<ws>/<ts>）
    pub name: String,
    /// 创建时间戳（unix 秒）
    pub created_at: i64,
    /// 触发操作（discard / reset_hard / checkout / rebase / branch_delete）
    pub context: String,
    /// 快照是否捕获了未提交改动
    pub has_changes: bool,
    /// 快照时所在分支
    pub branch: Option<String>,
}

/// 快照事件载荷（cap.git 危险操作成功后 emit 到前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoSnapshotEvent {
    /// 仓库工作区路径
    pub ws_path: String,
    /// 快照 ref 名
    pub snapshot_ref: String,
    /// 触发操作
    pub context: String,
}

/// 恢复快照的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoRestoreOutcome {
    /// 是否恢复成功
    pub ok: bool,
    /// 遇冲突时冲突文件列表（未冲突为 empty）
    pub conflicted_files: Vec<String>,
    /// 冲突说明（无冲突为 None）
    pub conflict_message: Option<String>,
}

// ============================================================================
// 操作流水（FR-P2-4：GitKraken Activity Log 等价）
// ============================================================================

/// 一次 cap.git 写操作留痕（前端「操作流水」面板只读展示；会话内滚动保留）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationEntry {
    /// 仓库工作区路径
    pub ws_path: String,
    /// 动作名（cap.git action，机器可读）
    pub action: String,
    /// 展示名（前端可直接呈现的中文操作名）
    pub label: String,
    /// 成败
    pub ok: bool,
    /// 耗时（ms）
    pub duration_ms: u64,
    /// 来源（bootstrap / remote / plugin:<id>）
    pub source: String,
    /// 完成时间（unix 秒）
    pub ts: i64,
    /// P2.5 任务队列 taskId（未启用为 None）
    pub git_task_id: Option<String>,
}

// ============================================================================
// 冲突预测（FR-P2-AI4：fetch 后确定性风险清单）
// ============================================================================

/// 对方 ahead commits 涉及的文件 ∩ 本地 modified 文件的冲突风险清单。
/// 纯后端确定性计算（0 token），前端直接显示；AI 解释层已由 master-plan §1.2 砍掉，
/// 仅保留规则建议（advice）。详见 plans/git-panel-p2-conflict-predict-spec.md。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictPrediction {
    /// 计算对象分支名
    pub branch: String,
    /// upstream 的 shorthand 名（无上游为 None → 无比较对象）
    pub upstream: Option<String>,
    /// 对方领先的提交数（HEAD..upstream 计数）
    pub behind: usize,
    /// 对方提交预览（sha / summary，倒序新→旧）
    pub incoming: Vec<GitIncomingCommitPreview>,
    /// 本地已修改路径（staged + unstaged，不含纯 untracked）
    pub local_modified: Vec<String>,
    /// 对方提交涉及的全部路径
    pub incoming_files: Vec<String>,
    /// 交集 = 冲突风险清单（risk_files 空 → 直接 pull 安全）
    pub risk_files: Vec<String>,
    /// 建议规则："none"（安全/无上游）| "commitOrStash"（本地未提交 + 有风险 → 先提交或储藏）
    pub advice: String,
}

/// 对方单个提交的预览（供前端展示，不进 risk 明细）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIncomingCommitPreview {
    pub sha: String,
    pub short_sha: String,
    pub summary: String,
}
