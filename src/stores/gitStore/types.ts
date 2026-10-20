/**
 * GitStore 类型定义
 *
 * 用于 Zustand slice 模式的共享类型
 */

import type { StateCreator } from 'zustand'
import type {
  GitRepositoryStatus,
  GitDiscoveredRepo,
  GitDiffEntry,
  GitBranch,
  GitRemote,
  GitHostType,
  PullRequest,
  CreatePROptions,
  GitPullResult,
  GitPushResult,
  GitMergeResult,
  GitRebaseResult,
  GitRebasePlan,
  GitRebaseSuggestion,
  GitRebaseTodoItem,
  GitCommitRiskReport,
  GitCherryPickResult,
  GitRevertResult,
  GitCommit,
  GitCommitDetails,
  GitFileHistoryEntry,
  GitTag,
  GitBlameResult,
  BatchStageResult,
  GitStashEntry,
  GitReflogEntry,
  GitLogSearchFilter,
  GitLogPage,
  GitIgnoreResult,
  GitIgnoreTemplate,
  UndoSnapshotMeta,
  UndoRestoreOutcome,
  GitOperationEntry,
  GitConflictPrediction,
  GitSequenceState,
} from '@/types/git'

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 解析 Git 错误
 */
export function parseGitError(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  if (typeof err === 'object' && err !== null) {
    const gitErr = err as { message?: string; details?: string }
    if (gitErr.message) {
      return gitErr.details 
        ? `${gitErr.message} (${gitErr.details})`
        : gitErr.message
    }
    try {
      return JSON.stringify(err)
    } catch {
      return '[object Object]'
    }
  }
  return String(err)
}

// ============================================================================
// Slice 状态类型定义
// ============================================================================

/**
 * 状态数据
 */
export interface StatusState {
  status: GitRepositoryStatus | null
  /** 按仓库路径键控的状态缓存。多仓库/多面板场景下各路径互不覆盖；
   *  只有当前生效路径与 status 字段保持一致 */
  statuses: Record<string, GitRepositoryStatus | null>
  /** 每个仓库路径的刷新序号，用于丢弃乱序返回的旧请求 */
  _statusSeq: Record<string, number>
  diffs: GitDiffEntry[]
  worktreeDiffs: GitDiffEntry[]
  indexDiffs: GitDiffEntry[]
  /** P1.5 分片：按 wsPath 键控的差异列表（新图面板直接读此域，防双面板互踩） */
  diffsByWs?: Record<string, GitDiffEntry[]>
  worktreeDiffsByWs?: Record<string, GitDiffEntry[]>
  indexDiffsByWs?: Record<string, GitDiffEntry[]>
  isLoading: boolean
  error: string | null
  selectedFilePath: string | null
  selectedDiff: GitDiffEntry | null
  /** 工作区下扫描到的子仓库（聚合工作区场景） */
  discoveredRepos: GitDiscoveredRepo[]
  /** 子仓库扫描进行中 */
  isDiscovering: boolean
  /** 当前工作区下用户置顶的子仓库路径（持久化到 localStorage） */
  pinnedRepos: string[]
  /**
   * Git 面板独立的工作区指针（不受 FileExplorer 的 viewingWorkspaceId 影响）。
   * 仅保存在内存：面板内下拉切换工作区时使用，不影响全局/文件浏览器的浏览状态。
   * 跟随全局 currentWorkspaceId 变化（见 useGitActiveWorkspace）。
   */
  activeWorkspaceId: string | null
  // 内部状态（用于防抖和请求管理）
  _refreshPromises: Map<string, Promise<void>>
  _refreshTimeouts: Map<string, NodeJS.Timeout>
}

/**
 * 分支状态
 */
export interface BranchState {
  branches: GitBranch[]
  /** P1.5 分片：按 wsPath 键控的分支数据（双面板/多仓互防；新图面板直接读此域） */
  branchesByWs?: Record<string, GitBranch[]>
}

/**
 * 远程状态
 */
export interface RemoteState {
  remotes: GitRemote[]
  /** P1.5 分片：按 wsPath 键控的远程数据 */
  remotesByWs?: Record<string, GitRemote[]>
}

/**
 * Tag 状态
 */
export interface TagState {
  tags: GitTag[]
  /** P1.5 分片：按 wsPath 键控的标签数据 */
  tagsByWs?: Record<string, GitTag[]>
}

/**
 * Commit 状态
 */
export interface CommitState {
  commits: GitCommit[]
  /** P1.5 分片：按 wsPath 键控的提交历史 */
  commitsByWs?: Record<string, GitCommit[]>
  commitDetails: Record<string, GitCommitDetails>
  /** P3 AI-3：按 wsPath 键控的提交前风险扫描报告（Review 门，纯本地） */
  riskScanByWs?: Record<string, GitCommitRiskReport>
}

/**
 * Stash 状态
 */
export interface StashState {
  stashList: GitStashEntry[]
  /** P1.5 分片：按 wsPath 键控的 stash 数据 */
  stashListByWs?: Record<string, GitStashEntry[]>
}

/**
 * PR 状态
 */
export interface PRState {
  currentPR: PullRequest | null
}

/**
 * Undo 网络状态（FR-P2-3：危险操作快照）
 */
export interface UndoState {
  /** 当前工作区的撤销快照列表（倒序按时间） */
  undoSnapshots: UndoSnapshotMeta[]
  /** P1.5 分片：按 wsPath 键控的快照列表（双面板/多仓互防） */
  undoSnapshotsByWs?: Record<string, UndoSnapshotMeta[]>
}

/**
 * 操作流水状态（FR-P2-4：写动作留痕，GitKraken Activity Log 等价）
 */
export interface OperationsState {
  /** 当前工作区的操作流水（倒序：最新在上，上限 50/ws，会话内滚动） */
  operations: GitOperationEntry[]
  /** P1.5 分片：按 wsPath 键控的操作流水 */
  operationsByWs?: Record<string, GitOperationEntry[]>
}

/**
 * 冲突预测状态（FR-P2-AI4：fetch 后确定性风险清单，0 token）
 */
export interface ConflictPredictState {
  /** 当前工作区的冲突预测结果（null = 尚未计算 / 无上游 / 计算失败） */
  conflictPrediction: GitConflictPrediction | null
  /** P1.5 分片：按 wsPath 键控的冲突预测结果 */
  conflictPredictionsByWs?: Record<string, GitConflictPrediction | null>
}

// ============================================================================
// Slice 方法类型定义
// ============================================================================

/**
 * 状态操作方法
 */
export interface StatusActions {
  refreshStatus: (workspacePath: string) => Promise<void>
  refreshStatusDebounced: (workspacePath: string, delay?: number) => Promise<void>
  getDiffs: (workspacePath: string, baseCommit: string) => Promise<void>
  getWorktreeDiff: (workspacePath: string) => Promise<void>
  getIndexDiff: (workspacePath: string) => Promise<void>
  getWorktreeFileDiff: (workspacePath: string, filePath: string) => Promise<GitDiffEntry>
  getIndexFileDiff: (workspacePath: string, filePath: string) => Promise<GitDiffEntry>
  /** 扫描工作区下所有嵌套 Git 子仓库（聚合工作区场景） */
  discoverRepositories: (workspacePath: string, maxDepth?: number) => Promise<GitDiscoveredRepo[]>
  /** 切换某子仓库的置顶状态（持久化到 localStorage） */
  togglePinnedRepo: (workspacePath: string, repoPath: string) => void
  /** 查询某子仓库是否已置顶 */
  isPinnedRepo: (repoPath: string) => boolean
  /** 为指定工作区加载置顶列表（从 localStorage） */
  loadPinnedRepos: (workspacePath: string) => void
  clearError: () => void
  clearAll: () => void
  hasChanges: (workspacePath?: string) => boolean
  getChangedFiles: (workspacePath?: string) => string[]
  setSelectedFilePath: (path: string | null) => void
  setSelectedDiff: (diff: GitDiffEntry | null) => void
  /** 设置 Git 面板独立工作区（仅内存态，不影响 FileExplorer 浏览状态） */
  setActiveWorkspaceId: (id: string | null) => void
}

/**
 * 分支操作方法
 */
export interface BranchActions {
  getBranches: (workspacePath: string) => Promise<void>
  createBranch: (workspacePath: string, name: string, checkout?: boolean, startPoint?: string) => Promise<void>
  deleteBranch: (workspacePath: string, name: string, force?: boolean) => Promise<void>
  renameBranch: (workspacePath: string, oldName: string, newName: string) => Promise<void>
  checkoutBranch: (workspacePath: string, name: string) => Promise<void>
  mergeBranch: (workspacePath: string, sourceBranch: string, noFF?: boolean) => Promise<GitMergeResult>
  rebaseBranch: (workspacePath: string, sourceBranch: string) => Promise<GitRebaseResult>
  rebaseAbort: (workspacePath: string) => Promise<void>
  rebaseContinue: (workspacePath: string) => Promise<GitRebaseResult>
  /** 面板化 Interactive Rebase（P3 FR-P3-2）：预览计划（只读） */
  planInteractiveRebase: (workspacePath: string, baseCommitish: string) => Promise<GitRebasePlan>
  /** 面板 todo 确认后执行（写类；冲突走 rebase_continue + 冲突合并器） */
  startInteractiveRebase: (
    workspacePath: string,
    baseCommitish: string,
    todos: GitRebaseTodoItem[],
    autosquash: boolean,
  ) => Promise<GitRebaseResult>
  /** P3 AI-8：fixup!/squash! 整理建议（只读，纯本地）——建议序列可直接喂 startInteractiveRebase */
  suggestRebaseTodos: (workspacePath: string, baseCommitish: string) => Promise<GitRebaseSuggestion>
}

/**
 * 远程操作方法
 */
export interface RemoteActions {
  getRemotes: (workspacePath: string) => Promise<void>
  addRemote: (workspacePath: string, name: string, url: string) => Promise<GitRemote>
  removeRemote: (workspacePath: string, name: string) => Promise<void>
  push: (workspacePath: string, branchName: string, remoteName?: string, force?: boolean, setUpstream?: boolean, remoteBranchName?: string, leaseSha?: string) => Promise<GitPushResult>
  /** P1：force-with-lease 期望远端 sha（可选，配合 force 使用实现安全强推） */
  pushWithLease: (workspacePath: string, branchName: string, remoteName?: string, remoteBranchName?: string, leaseSha?: string) => Promise<GitPushResult>
  /** P1：fetch（remoteName 缺省 = origin；prune 清理已删 remote-tracking refs） */
  fetchRemote: (workspacePath: string, remoteName?: string, prune?: boolean) => Promise<string>
  pull: (workspacePath: string, remoteName?: string, branchName?: string) => Promise<GitPullResult>
  detectHostAsync: (remoteUrl: string) => Promise<GitHostType>
}

/**
 * Tag 操作方法
 */
export interface TagActions {
  getTags: (workspacePath: string) => Promise<GitTag[]>
  createTag: (workspacePath: string, name: string, commitish?: string, message?: string) => Promise<GitTag>
  deleteTag: (workspacePath: string, name: string) => Promise<void>
}

/**
 * Commit 操作方法
 */
export interface CommitActions {
  commitChanges: (workspacePath: string, message: string, stageAll?: boolean, selectedFiles?: string[]) => Promise<string>
  /** AI-2：按组原子提交（只提交组内文件，index 其它已暂存内容不受影响，等价 git commit <paths>） */
  commitGroup: (workspacePath: string, message: string, files: string[]) => Promise<string>
  stageFile: (workspacePath: string, filePath: string) => Promise<void>
  unstageFile: (workspacePath: string, filePath: string) => Promise<void>
  discardChanges: (workspacePath: string, filePath: string) => Promise<void>
  batchStage: (workspacePath: string, filePaths: string[]) => Promise<BatchStageResult>
  getLog: (workspacePath: string, limit?: number, skip?: number, branch?: string) => Promise<GitCommit[]>
  /** P2 泳道图：commits（含 refs 装饰）+ rows（lane 数据）同一次返回 */
  getLogWithLanes: (workspacePath: string, limit?: number, skip?: number, branch?: string) => Promise<GitLogPage>
  /** P1：amend HEAD（message 省略 = 仅合并 staged 内容 / --no-edit 语义；任意历史 commit amend 依赖 P3） */
  amendCommit: (workspacePath: string, message?: string, stageAll?: boolean, selectedFiles?: string[]) => Promise<string>
  /** P1：提交历史搜索（grep/author/pickaxe/since/分支范围；AI-6 参数编译器的动作端） */
  searchLog: (workspacePath: string, filter: GitLogSearchFilter, limit?: number, skip?: number) => Promise<GitCommit[]>
  getCommitDetails: (workspacePath: string, commitSha: string) => Promise<GitCommitDetails>
  getFileHistory: (workspacePath: string, filePath: string, limit?: number, skip?: number, branch?: string) => Promise<GitFileHistoryEntry[]>
  checkoutCommit: (workspacePath: string, commitSha: string) => Promise<void>
  /** P3 AI-3：提交前风险扫描（Review 门；只读，纯本地）——结果写入 riskScanByWs */
  scanCommitRisk: (workspacePath: string) => Promise<GitCommitRiskReport>
}

/**
 * Stash 操作方法
 */
export interface StashActions {
  stashSave: (workspacePath: string, message?: string, includeUntracked?: boolean) => Promise<string>
  stashPop: (workspacePath: string, index?: number) => Promise<void>
  /** P1：应用 Stash 但保留 stash（与 pop 的区别：不 drop） */
  stashApply: (workspacePath: string, index?: number) => Promise<void>
  /** P1：查看 Stash patch 内容（raw diff 文本，交给 diff 渲染器） */
  stashShow: (workspacePath: string, index?: number) => Promise<string>
  stashDrop: (workspacePath: string, index: number) => Promise<void>
  getStashList: (workspacePath: string) => Promise<GitStashEntry[]>
}

/**
 * 高级操作方法
 */
export interface AdvancedActions {
  cherryPick: (workspacePath: string, commitSha: string) => Promise<GitCherryPickResult>
  cherryPickAbort: (workspacePath: string) => Promise<void>
  cherryPickContinue: (workspacePath: string) => Promise<GitCherryPickResult>
  revert: (workspacePath: string, commitSha: string) => Promise<GitRevertResult>
  revertAbort: (workspacePath: string) => Promise<void>
  revertContinue: (workspacePath: string) => Promise<GitRevertResult>
  reset: (workspacePath: string, mode: 'soft' | 'mixed' | 'hard', commitSha: string) => Promise<void>
}

/**
 * PR 操作方法
 */
export interface PRActions {
  createPR: (workspacePath: string, options: CreatePROptions) => Promise<PullRequest>
  getPRStatus: (workspacePath: string, prNumber: number) => Promise<PullRequest>
}

/**
 * Gitignore 操作方法
 */
export interface GitignoreActions {
  getGitignore: (workspacePath: string) => Promise<GitIgnoreResult>
  saveGitignore: (workspacePath: string, content: string) => Promise<void>
  addToGitignore: (workspacePath: string, rules: string[]) => Promise<void>
  getGitignoreTemplates: () => Promise<GitIgnoreTemplate[]>
}

/**
 * 工具方法
 */
export interface UtilityActions {
  isRepository: (workspacePath: string) => Promise<boolean>
  initRepository: (workspacePath: string, initialBranch?: string) => Promise<string>
  blameFile: (workspacePath: string, filePath: string) => Promise<GitBlameResult>
  /** P1：读取 reflog（null/undefined = HEAD；一键恢复复用 checkoutCommit） */
  getReflog: (workspacePath: string, branch?: string | null, limit?: number) => Promise<GitReflogEntry[]>
}

/**
 * Undo 网络操作方法（FR-P2-3：危险操作快照 + 一键恢复）
 */
export interface UndoActions {
  /** 列出某 workspace 的全部撤销快照（倒序按时间） */
  listUndoSnapshots: (workspacePath: string) => Promise<UndoSnapshotMeta[]>
  /** 一键恢复（stash apply / 重建被删分支 ref；遇冲突返回 conflictedFiles 不抛错） */
  restoreUndoSnapshot: (workspacePath: string, snapshotRef: string) => Promise<UndoRestoreOutcome>
  /** 手动清理快照（连同 .restore. note ref） */
  dropUndoSnapshot: (workspacePath: string, snapshotRef: string) => Promise<void>
}

/**
 * 操作流水操作方法（FR-P2-4：只读展示 / 清空）
 */
export interface OperationsActions {
  /** 拉取某 workspace 的操作流水（倒序，上限 50/ws） */
  getOperations: (workspacePath: string) => Promise<GitOperationEntry[]>
  /** 清空某 workspace 的操作流水（写类动作） */
  clearOperations: (workspacePath: string) => Promise<void>
}

/**
 * 冲突预测操作方法（FR-P2-AI4：只读、确定性计算，0 token）
 */
export interface ConflictPredictActions {
  /** 预测某 workspace 的冲突风险（branch 缺省 = 当前 HEAD 分支）；
   *  返回预测对象，失败返回 null（不抛错，卡片显示空态） */
  predictConflicts: (workspacePath: string, branch?: string) => Promise<GitConflictPrediction | null>
}

// ============================================================================
// 冲突合并器（P3：序列操作机 + 三窗合并器）
// ============================================================================

export interface ConflictState {
  /** 各 workspace 的序列操作状态缓存（按 wsPath 分片） */
  sequenceStatesByWs: Record<string, GitSequenceState>
  /** 合并器打开状态（null = 关闭） */
  mergerOpen: { wsPath: string; file?: string } | null
}

export interface ConflictActions {
  /** 拉取某 workspace 的序列操作状态（只读，失败置空态不抛错） */
  getConflictState: (workspacePath: string) => Promise<GitSequenceState | null>
  /** 写类解决：把内容（编辑器拼合结果/保留修改文本）写回工作区 + 暂存 */
  resolveConflictFile: (workspacePath: string, filePath: string, content: string) => Promise<boolean>
  /** 删类解决：接受删除（删盘上文件 + 移除 index 冲突 stages） */
  removeConflictFile: (workspacePath: string, filePath: string) => Promise<boolean>
  /** 整文件取舍：还原指定侧 stage 内容到工作区并暂存（binary / delete-modify） */
  checkoutConflictSide: (workspacePath: string, filePath: string, side: 'ours' | 'theirs') => Promise<boolean>
  /** 打开合并器（独立对话框形态） */
  openMerger: (wsPath: string, file?: string) => void
  /** 关闭合并器 */
  closeMerger: () => void
}

// ============================================================================
// 组合状态类型
// ============================================================================

/**
 * 完整的 Git 状态
 */
export type GitState = StatusState &
  BranchState &
  RemoteState &
  TagState &
  CommitState &
  StashState &
  PRState &
  UndoState &
  OperationsState &
  ConflictPredictState &
  ConflictState &
  StatusActions &
  BranchActions &
  RemoteActions &
  TagActions &
  CommitActions &
  StashActions &
  AdvancedActions &
  PRActions &
  GitignoreActions &
  UtilityActions &
  UndoActions &
  OperationsActions &
  ConflictPredictActions &
  ConflictActions

// ============================================================================
// Slice Creator 类型
// ============================================================================

/** 状态 Slice Creator 类型 */
export type StatusSlice = StateCreator<GitState, [], [], StatusState & StatusActions>

/** 分支 Slice Creator 类型 */
export type BranchSlice = StateCreator<GitState, [], [], BranchState & BranchActions>

/** 远程 Slice Creator 类型 */
export type RemoteSlice = StateCreator<GitState, [], [], RemoteState & RemoteActions>

/** Tag Slice Creator 类型 */
export type TagSlice = StateCreator<GitState, [], [], TagState & TagActions>

/** Commit Slice Creator 类型 */
export type CommitSlice = StateCreator<GitState, [], [], CommitState & CommitActions>

/** Stash Slice Creator 类型 */
export type StashSlice = StateCreator<GitState, [], [], StashState & StashActions>

/** 高级操作 Slice Creator 类型 */
export type AdvancedSlice = StateCreator<GitState, [], [], AdvancedActions>

/** PR Slice Creator 类型 */
export type PRSlice = StateCreator<GitState, [], [], PRState & PRActions>

/** Gitignore Slice Creator 类型 */
export type GitignoreSlice = StateCreator<GitState, [], [], GitignoreActions>

/** 工具方法 Slice Creator 类型 */
export type UtilitySlice = StateCreator<GitState, [], [], UtilityActions>

/** Undo 网络 Slice Creator 类型（FR-P2-3） */
export type UndoSlice = StateCreator<GitState, [], [], UndoState & UndoActions>

/** 操作流水 Slice Creator 类型（FR-P2-4） */
export type OperationsSlice = StateCreator<GitState, [], [], OperationsState & OperationsActions>

/** 冲突预测 Slice Creator 类型（FR-P2-AI4） */
export type ConflictPredictSlice = StateCreator<GitState, [], [], ConflictPredictState & ConflictPredictActions>

/** 冲突合并器 Slice Creator 类型（P3） */
export type ConflictSlice = StateCreator<GitState, [], [], ConflictState & ConflictActions>
