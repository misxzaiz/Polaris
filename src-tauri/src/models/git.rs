/*! Git 数据模型
 *
 * Rust 端的 Git 相关数据结构定义
 */

use serde::{Deserialize, Serialize};

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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for GitError {}

/// Git 服务错误（内部使用）
#[derive(Debug)]
pub enum GitServiceError {
    GitError(git2::Error),
    IoError(std::io::Error),
    NotARepository,
    BranchNotFound(String),
    CommitNotFound(String),
    ConflictsDetected {
        message: String,
        conflicted_files: Vec<String>,
    },
    RebaseInProgress,
    CherryPickInProgress,
    RevertInProgress,
    MergeInProgress,
    RemoteNotFound(String),
    RemoteExists(String),
    CLINotFound(String),
    CLIError(String),
}

impl std::fmt::Display for GitServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GitError(e) => write!(f, "Git error: {}", e),
            Self::IoError(e) => write!(f, "IO error: {}", e),
            Self::NotARepository => write!(f, "Not a Git repository"),
            Self::BranchNotFound(name) => write!(f, "Branch '{}' not found", name),
            Self::CommitNotFound(sha) => write!(f, "Commit '{}' not found", sha),
            Self::ConflictsDetected {
                message,
                conflicted_files,
            } => {
                write!(f, "Merge conflicts: {}. Files: {:?}", message, conflicted_files)
            }
            Self::RebaseInProgress => write!(f, "Rebase is already in progress"),
            Self::CherryPickInProgress => write!(f, "Cherry-pick is already in progress"),
            Self::RevertInProgress => write!(f, "Revert is already in progress"),
            Self::MergeInProgress => write!(f, "Merge is already in progress"),
            Self::RemoteNotFound(name) => write!(f, "Remote '{}' not found", name),
            Self::RemoteExists(name) => write!(f, "Remote '{}' already exists", name),
            Self::CLINotFound(cli) => write!(f, "CLI tool '{}' not found", cli),
            Self::CLIError(err) => write!(f, "CLI error: {}", err),
        }
    }
}

impl std::error::Error for GitServiceError {}

impl From<git2::Error> for GitServiceError {
    fn from(err: git2::Error) -> Self {
        Self::GitError(err)
    }
}

impl From<std::io::Error> for GitServiceError {
    fn from(err: std::io::Error) -> Self {
        Self::IoError(err)
    }
}

// ============================================================================
// 分支比较
// ============================================================================

/// 分支比较结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchComparison {
    pub ahead: usize,
    pub behind: usize,
    pub diverged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub common_ancestor: Option<String>,
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
    pub conflicts: Vec<String>,
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
    /// 冲突文件列表
    pub conflicts: Vec<String>,
    /// 合并的提交数
    pub merged_commits: usize,
    /// 变更的文件数
    pub files_changed: usize,
}

/// Rebase 操作结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRebaseResult {
    /// 是否成功
    pub success: bool,
    /// 是否有冲突
    pub has_conflicts: bool,
    /// 冲突文件列表
    pub conflicts: Vec<String>,
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
    /// 冲突文件列表
    pub conflicts: Vec<String>,
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
    /// 冲突文件列表
    pub conflicts: Vec<String>,
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
// 冲突文件
// ============================================================================

/// 冲突文件信息
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
