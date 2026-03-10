/**
 * Git 相关类型定义
 *
 * 用于 Polaris 的 Git 操作和代码审查功能
 */

/**
 * Git 文件状态
 */
export type GitFileStatus =
  | 'untracked'     // 未跟踪
  | 'modified'       // 已修改
  | 'added'          // 已添加到暂存区
  | 'deleted'        // 已删除
  | 'renamed'        // 已重命名
  | 'copied'         // 已复制
  | 'unmerged'       // 未合并（冲突）

/**
 * Git 文件变更
 */
export interface GitFileChange {
  path: string          // 文件路径
  status: GitFileStatus // 状态
  oldPath?: string      // 重命名前的路径
  additions?: number    // 新增行数
  deletions?: number    // 删除行数
}

/**
 * Git 仓库状态
 */
export interface GitRepositoryStatus {
  exists: boolean                // 是否为 Git 仓库
  branch: string                 // 当前分支
  commit: string                 // 当前 commit SHA (完整)
  shortCommit: string            // 短 SHA (前8位)
  ahead: number                  // 领先提交数
  behind: number                 // 落后提交数
  staged: GitFileChange[]        // 已暂存变更
  unstaged: GitFileChange[]      // 未暂存变更
  untracked: string[]            // 未跟踪文件
  conflicted: string[]           // 冲突文件
  isEmpty: boolean               // 是否为空仓库
}

/**
 * Git Diff 变更类型
 */
export type DiffChangeType = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied'

/**
 * Git Diff 条目
 */
export interface GitDiffEntry {
  file_path: string
  old_file_path?: string
  change_type: DiffChangeType
  old_content?: string
  new_content?: string
  additions?: number
  deletions?: number
  is_binary: boolean
  content_omitted?: boolean  // 内容过大被省略
  status_hint?: {            // 状态冲突提示
    has_conflict: boolean
    message?: string
    current_view: string
  }
}

/**
 * Git 提交信息
 */
export interface GitCommit {
  sha: string
  shortSha: string
  message: string
  author: string
  authorEmail: string
  timestamp: number
  parents: string[]
}

/**
 * Git 分支
 */
export interface GitBranch {
  name: string
  isCurrent: boolean
  isRemote: boolean
  commit: string
  ahead?: number
  behind?: number
  lastCommitDate?: number
}

/**
 * Git 标签
 */
export interface GitTag {
  /** 标签名称 */
  name: string
  /** 是否为轻量标签（true = 轻量标签，false = 附注标签） */
  isLightweight: boolean
  /** 标签对应的提交 SHA */
  commitSha: string
  /** 短 SHA */
  shortSha: string
  /** 标签消息（仅附注标签） */
  message?: string
  /** 标签创建者（仅附注标签） */
  tagger?: string
  /** 标签创建时间（仅附注标签） */
  timestamp?: number
}

/**
 * Git 远程仓库
 */
export interface GitRemote {
  name: string
  fetchUrl?: string
  pushUrl?: string
}

/**
 * Pull Request 状态
 */
export type PRState = 'open' | 'merged' | 'closed'

/**
 * Pull Request 审查状态
 */
export type PRReviewStatus = 'approved' | 'changes_requested' | 'pending' | 'commented'

/**
 * Pull Request 信息
 */
export interface PullRequest {
  number: number
  url: string
  title: string
  body?: string
  state: PRState
  headBranch: string
  baseBranch: string
  createdAt: number
  updatedAt: number
  mergedAt?: number
  closedAt?: number
  author: string
  reviewStatus?: PRReviewStatus
  additions?: number
  deletions?: number
  changedFiles?: number
}

/**
 * Git 主机类型
 */
export type GitHostType = 'github' | 'gitlab' | 'azure-devops' | 'bitbucket' | 'unknown'

/**
 * PR 创建选项
 */
export interface CreatePROptions {
  title: string
  body?: string
  headBranch: string
  baseBranch: string
  draft?: boolean
  assignees?: string[]
  labels?: string[]
}

/**
 * Git 操作错误
 */
export interface GitError {
  code: string
  message: string
  details?: string
}

/**
 * Git 操作结果（统一返回类型）
 */
export type GitResult<T> = {
  success: true
  data: T
} | {
  success: false
  error: GitError
}

/**
 * Rebase 状态
 */
export type RebaseState = 'not_started' | 'in_progress' | 'conflict' | 'finished'

/**
 * 合并类型
 */
export type MergeType = 'merge' | 'squash' | 'rebase'

/**
 * Git 操作选项
 */
export interface GitOperationOptions {
  stageAll?: boolean      // 是否暂存所有变更
  amend?: boolean         // 是否修正上次提交
  allowEmpty?: boolean    // 是否允许空提交
}

/**
 * 分支比较结果
 */
export interface BranchComparison {
  ahead: number           // 领先提交数
  behind: number          // 落后提交数
  diverged: boolean       // 是否分叉
  commonAncestor?: string // 共同祖先 commit
}

/**
 * Pull 操作结果
 */
export interface GitPullResult {
  success: boolean
  fastForward: boolean
  pulledCommits: number
  filesChanged: number
  insertions: number
  deletions: number
  conflicts: string[]
}

/**
 * Push 操作结果
 */
export interface GitPushResult {
  success: boolean
  pushedCommits: number  // 推送的提交数
  needsUpstream: boolean // 是否需要设置上游分支
  rejected: boolean      // 是否被拒绝（需要强制推送或拉取）
  error?: string         // 错误信息
}

/**
 * Merge 操作结果
 */
export interface GitMergeResult {
  success: boolean       // 是否成功
  fastForward: boolean   // 是否为快进合并
  hasConflicts: boolean  // 是否有冲突
  conflicts: string[]    // 冲突文件列表
  mergedCommits: number  // 合并的提交数
  filesChanged: number   // 变更的文件数
}

/**
 * Rebase 操作结果
 */
export interface GitRebaseResult {
  success: boolean       // 是否成功
  hasConflicts: boolean  // 是否有冲突
  conflicts: string[]    // 冲突文件列表
  rebasedCommits: number // 变基的提交数
  currentStep: number    // 当前步骤（从 1 开始）
  totalSteps: number     // 总步骤数
  finished: boolean      // 是否已完成
}

/**
 * Cherry-pick 操作结果
 */
export interface GitCherryPickResult {
  success: boolean       // 是否成功
  hasConflicts: boolean  // 是否有冲突
  conflicts: string[]    // 冲突文件列表
  commitSha: string      // 提交 SHA
  commitMessage: string  // 提交消息
  finished: boolean      // 是否已完成
}

/**
 * Revert 操作结果
 */
export interface GitRevertResult {
  success: boolean       // 是否成功
  hasConflicts: boolean  // 是否有冲突
  conflicts: string[]    // 冲突文件列表
  commitSha: string      // 提交 SHA
  commitMessage: string  // 提交消息
  finished: boolean      // 是否已完成
}

/**
 * 批量暂存结果
 */
export interface BatchStageResult {
  staged: string[]
  failed: StageFailure[]
  total: number
}

/**
 * 暂存失败信息
 */
export interface StageFailure {
  path: string
  error: string
}

/**
 * Stash 条目
 */
export interface GitStashEntry {
  index: number
  message: string
  branch: string
  commitSha: string
  timestamp: number
}

/**
 * 冲突文件信息
 */
export interface ConflictedFile {
  path: string
  baseContent?: string    // 基础版本内容
  ourContent?: string     // 当前版本内容
  theirContent?: string   // 传入版本内容
  resolved: boolean       // 是否已解决
}

/**
 * 审查上下文（用于 Review 与 Git 集成）
 */
export interface ReviewGitContext {
  baseCommit: string        // 审查基准 commit
  currentCommit: string     // 当前 commit
  branch: string            // 当前分支
  changedFiles: string[]    // 变更文件列表
  diffsAvailable: boolean   // Diff 是否可用
}

/**
 * 文件级评论（用于代码审查）
 */
export interface FileComment {
  id: string
  reviewId: string
  filePath: string
  line?: number              // 行号
  content: string
  type: CommentType
  priority: CommentPriority
  resolved: boolean
  createdAt: number
  author?: string
}

/**
 * 评论类型
 */
export type CommentType = 'suggestion' | 'issue' | 'question' | 'approval'

/**
 * 评论优先级
 */
export type CommentPriority = 'low' | 'medium' | 'high'

/**
 * Diff 快照（用于审查）
 */
export interface DiffSnapshot {
  id: string
  reviewId: string
  filePath: string
  oldContent: string
  newContent: string
  changeType: DiffChangeType
  capturedAt: number
}

/**
 * Git 工作流配置
 */
export interface GitWorkflowConfig {
  defaultBranch?: string      // 默认分支名
  autoCommit?: boolean         // 是否自动提交
  autoPush?: boolean           // 是否自动推送
  requireReview?: boolean      // 是否需要审查
  prTemplate?: string          // PR 模板
  commitMessageTemplate?: string // 提交消息模板
}
