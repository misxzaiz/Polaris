/**
 * GitStore 类型定义
 *
 * 用于 Zustand slice 模式的共享类型
 */

import type { StateCreator } from 'zustand'
import type {
  GitRepositoryStatus,
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
  GitCherryPickResult,
  GitRevertResult,
  GitCommit,
  GitCommitDetails,
  GitFileHistoryEntry,
  GitTag,
  GitBlameResult,
  BatchStageResult,
  GitStashEntry,
  GitIgnoreResult,
  GitIgnoreTemplate,
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
  diffs: GitDiffEntry[]
  worktreeDiffs: GitDiffEntry[]
  indexDiffs: GitDiffEntry[]
  isLoading: boolean
  error: string | null
  selectedFilePath: string | null
  selectedDiff: GitDiffEntry | null
  // 内部状态（用于防抖和请求管理）
  _refreshPromises: Map<string, Promise<void>>
  _refreshTimeouts: Map<string, NodeJS.Timeout>
}

/**
 * 分支状态
 */
export interface BranchState {
  branches: GitBranch[]
}

/**
 * 远程状态
 */
export interface RemoteState {
  remotes: GitRemote[]
}

/**
 * Tag 状态
 */
export interface TagState {
  tags: GitTag[]
}

/**
 * Commit 状态
 */
export interface CommitState {
  commits: GitCommit[]
  commitDetails: Record<string, GitCommitDetails>
}

/**
 * Stash 状态
 */
export interface StashState {
  stashList: GitStashEntry[]
}

/**
 * PR 状态
 */
export interface PRState {
  currentPR: PullRequest | null
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
  clearError: () => void
  clearAll: () => void
  hasChanges: () => boolean
  getChangedFiles: () => string[]
  setSelectedFilePath: (path: string | null) => void
  setSelectedDiff: (diff: GitDiffEntry | null) => void
}

/**
 * 分支操作方法
 */
export interface BranchActions {
  getBranches: (workspacePath: string) => Promise<void>
  createBranch: (workspacePath: string, name: string, checkout?: boolean) => Promise<void>
  deleteBranch: (workspacePath: string, name: string, force?: boolean) => Promise<void>
  renameBranch: (workspacePath: string, oldName: string, newName: string) => Promise<void>
  checkoutBranch: (workspacePath: string, name: string) => Promise<void>
  mergeBranch: (workspacePath: string, sourceBranch: string, noFF?: boolean) => Promise<GitMergeResult>
  rebaseBranch: (workspacePath: string, sourceBranch: string) => Promise<GitRebaseResult>
  rebaseAbort: (workspacePath: string) => Promise<void>
  rebaseContinue: (workspacePath: string) => Promise<GitRebaseResult>
}

/**
 * 远程操作方法
 */
export interface RemoteActions {
  getRemotes: (workspacePath: string) => Promise<void>
  addRemote: (workspacePath: string, name: string, url: string) => Promise<GitRemote>
  removeRemote: (workspacePath: string, name: string) => Promise<void>
  push: (workspacePath: string, branchName: string, remoteName?: string, force?: boolean, setUpstream?: boolean, remoteBranchName?: string) => Promise<GitPushResult>
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
  stageFile: (workspacePath: string, filePath: string) => Promise<void>
  unstageFile: (workspacePath: string, filePath: string) => Promise<void>
  discardChanges: (workspacePath: string, filePath: string) => Promise<void>
  batchStage: (workspacePath: string, filePaths: string[]) => Promise<BatchStageResult>
  getLog: (workspacePath: string, limit?: number, skip?: number, branch?: string) => Promise<GitCommit[]>
  getCommitDetails: (workspacePath: string, commitSha: string) => Promise<GitCommitDetails>
  getFileHistory: (workspacePath: string, filePath: string, limit?: number, skip?: number, branch?: string) => Promise<GitFileHistoryEntry[]>
}

/**
 * Stash 操作方法
 */
export interface StashActions {
  stashSave: (workspacePath: string, message?: string, includeUntracked?: boolean) => Promise<string>
  stashPop: (workspacePath: string, index?: number) => Promise<void>
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
  StatusActions &
  BranchActions &
  RemoteActions &
  TagActions &
  CommitActions &
  StashActions &
  AdvancedActions &
  PRActions &
  GitignoreActions &
  UtilityActions

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
