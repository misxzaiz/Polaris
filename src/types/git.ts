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
 * 扫描到的子仓库信息（聚合工作区场景）
 *
 * 工作区本身非 git、下含多个并行 git 子项目时，
 * GitPanel 调用 git_discover_repositories 列出子仓库供用户选择。
 */
export interface GitDiscoveredRepo {
  path: string                   // 仓库绝对路径
  name: string                   // 目录名（展示用）
  branch: string                 // 当前分支名（空仓库时为空串）
  shortCommit: string            // 短 SHA（空仓库时为空串）
  isEmpty: boolean               // 是否为空仓库
  hasChanges: boolean            // 是否有未提交变更
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
  /** 该提交上的 refs 装饰（泳道图三色 + 标记）；缺省空数组 */
  refs?: GitCommitRef[]
}

/**
 * 提交上的 refs 装饰（与 Rust models::GitCommitRef camelCase 双边同步）
 */
export interface GitCommitRef {
  /** 显示名（如 main、origin/main、HEAD、v1.0） */
  name: string
  /** 分类：HEAD / 本地分支 / 远程分支 / tag */
  kind: 'head' | 'local' | 'remote' | 'tag'
  /** ref 全名（refs/heads/main 等） */
  target: string
}

/**
 * 泳道格子：该 commit 在泳道列位置的绘制原语
 * 与 Rust models::GitLaneCell camelCase 双边同步
 */
export interface GitLaneCell {
  /** 泳道下标 */
  lane: number
  /** 节点类型：commit / merge / empty / none */
  node: 'commit' | 'merge' | 'empty' | 'none'
  /** 下行边（连到下一行同泳道或换行） */
  edgeDown?: number
  /** 上行边（连到上一行不同泳道，即换行汇入） */
  edgeUp?: number
}

/**
 * 单条泳道行（每 commit 一行）
 */
export interface GitLaneRow {
  sha: string
  cells: GitLaneCell[]
  /** 冗余带 refs，前端不必再查 */
  refs: GitCommitRef[]
}

/**
 * 泳道图分页结果
 */
export interface GitLogPage {
  commits: GitCommit[]
  rows: GitLaneRow[]
}

/**
 * Reflog 条目（P1：reflog UI + 一键恢复 —— 恢复复用 checkout_commit）
 * 与 Rust models::GitReflogEntry（rename_all="camelCase"）双边同步
 */
export interface GitReflogEntry {
  /** 完整提交 sha（恢复目标） */
  sha: string
  shortSha: string
  /** reflog 选择器，如 HEAD@{0} / refs/heads/main@{3} */
  selector: string
  /** 动作描述（如 "checkout: moving from a to b"） */
  subject: string
  /** Unix 秒 */
  timestamp: number
  /** 关联分支名（selector 含 refs/heads/ 前缀时后端解析） */
  branch?: string
}

/** 提交历史搜索过滤器（P1；与 Rust models::LogSearchFilter camelCase 同步） */
export interface GitLogSearchFilter {
  /** --grep（匹配整条 message，正则；fixedStrings 时为字面子串） */
  grep?: string
  /** --author */
  author?: string
  /** -S pickaxe（代码内容变更次数搜索） */
  pickaxe?: string
  /** 路径过滤（--） */
  path?: string
  /** --since（"2 weeks ago" / "2026-01-01"） */
  since?: string
  /** --until */
  until?: string
  /** 分支范围（"a..b" / "a...b" / "main"） */
  range?: string
  /** 字面子串模式（--fixed-strings；AI-6 编译器把"包含 xx"映射到此开关） */
  fixedStrings?: boolean
}

/**
 * Git 提交详情
 */
export interface GitCommitDetails {
  commit: GitCommit
  files: GitDiffEntry[]
  totalAdditions: number
  totalDeletions: number
}

/**
 * 单文件提交历史条目
 */
export interface GitFileHistoryEntry {
  commit: GitCommit
  file: GitDiffEntry
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
 * Git Blame 单行信息
 */
export interface GitBlameLine {
  /** 行号（从 1 开始） */
  lineNumber: number
  /** 该行在原提交中的行号 */
  originalLineNumber: number
  /** 提交 SHA */
  commitSha: string
  /** 短 SHA */
  shortSha: string
  /** 作者名称 */
  author: string
  /** 作者邮箱 */
  authorEmail: string
  /** 提交时间（Unix 时间戳） */
  timestamp: number
  /** 提交消息（第一行） */
  summary?: string
  /** 文件内容 */
  content: string
}

/**
 * Git Blame 结果
 */
export interface GitBlameResult {
  /** 文件路径 */
  filePath: string
  /** Blame 行信息列表 */
  lines: GitBlameLine[]
  /** 总行数 */
  totalLines: number
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

/**
 * .gitignore 文件信息
 */
export interface GitIgnoreResult {
  /** 文件是否存在 */
  exists: boolean
  /** 文件内容 */
  content: string
  /** 文件路径（相对于仓库根目录） */
  path: string
}

/**
 * 常用忽略规则模板
 */
export interface GitIgnoreTemplate {
  /** 模板名称 */
  name: string
  /** 模板描述 */
  description: string
  /** 规则列表 */
  rules: string[]
}

// ============================================================================
// Undo 网络（FR-P2-3：危险操作快照 + 一键恢复）
// ============================================================================

/** 触发快照的危险操作来源 */
export type UndoSnapshotContext =
  | 'discard'
  | 'reset_hard'
  | 'checkout'
  | 'branch_delete'
  | 'rebase'
  | 'undo'

/**
 * 撤销快照元数据（通知条 / 快照列表展示）
 */
export interface UndoSnapshotMeta {
  /** 快照 ref 名（refs/polaris-undo/<ws>/<ts>） */
  name: string
  /** 创建时间戳（unix 秒） */
  createdAt: number
  /** 触发操作（discard / reset_hard / checkout / rebase / branch_delete） */
  context: string
  /** 快照是否捕获了未提交改动 */
  hasChanges: boolean
  /** 快照时所在分支 */
  branch: string | null
}

/**
 * 快照事件载荷（cap.git 危险操作成功后 emit 到前端 → toast「撤销」）
 */
export interface UndoSnapshotEvent {
  /** 仓库工作区路径 */
  wsPath: string
  /** 快照 ref 名 */
  snapshotRef: string
  /** 触发操作 */
  context: string
}

/**
 * 快照恢复结果
 */
export interface UndoRestoreOutcome {
  /** 是否恢复成功 */
  ok: boolean
  /** 遇冲突时冲突文件列表（未冲突为 empty） */
  conflictedFiles: string[]
  /** 冲突说明（无冲突为 null） */
  conflictMessage: string | null
}

/**
 * 操作流水条目（FR-P2-4：cap.git 写动作留痕，events 与 get_operations 同构）
 * 字段与服务端 models/git.rs::GitOperationEntry（camelCase serde）一一对应。
 */
export interface GitOperationEntry {
  /** 仓库工作区路径 */
  wsPath: string
  /** 动作名（commit_changes / discard_changes / ...） */
  action: string
  /** 展示名（后端给中文 label） */
  label: string
  /** 成败 */
  ok: boolean
  /** 耗时 ms */
  durationMs: number
  /** bootstrap / remote / plugin */
  source: string
  /** unix 秒 */
  ts: number
  /** P2.5 任务队列 taskId（未启用为 null） */
  gitTaskId: string | null
}

// ============================================================================
// 冲突预测（FR-P2-AI4：fetch 后确定性风险清单，0 token）
// ============================================================================

/**
 * 对方 incoming commit 预览（HEAD..upstream 中每笔提交）
 */
export interface GitIncomingCommitPreview {
  /** 完整提交 sha */
  sha: string
  /** 短 sha（前 8 位） */
  shortSha: string
  /** 提交摘要（第一行） */
  summary: string
}

/**
 * 冲突预测结果（cap.git `predict_conflicts` 返回值）
 * 字段与服务端 models/git.rs::GitConflictPrediction（camelCase serde）一一对应。
 */
export interface GitConflictPrediction {
  /** 计算所针对的本地分支名 */
  branch: string
  /** 上游分支（如 origin/main）；无上游为 null */
  upstream: string | null
  /** 落后提交数（HEAD..upstream） */
  behind: number
  /** incoming commits 预览列表 */
  incoming: GitIncomingCommitPreview[]
  /** 本地 modified 文件（staged + unstaged，不含 untracked） */
  localModified: string[]
  /** incoming 涉及的全部文件 */
  incomingFiles: string[]
  /** 风险文件 = incomingFiles ∩ localModified（pull 可能冲突的候选） */
  riskFiles: string[]
  /** 规则建议："none"（安全）| "commitOrStash"（建议先提交/暂存再拉取） */
  advice: 'none' | 'commitOrStash'
}
