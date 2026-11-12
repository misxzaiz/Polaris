/**
 * GitStore 类型定义 —— P0 瘦身后只保留 status 状态层契约。
 *
 * 内置 Git 面板的分支/远程/标签/提交/Stash/PR/Undo/操作流水/冲突等
 * slice 类型随 P0 一并删除；插件侧自有 repoStore 与类型定义。
 */

import type { StateCreator } from 'zustand'
import type {
  GitRepositoryStatus,
  GitDiffEntry,
  GitDiscoveredRepo,
} from '@/types/git'

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
  /** Git 面板独立的工作区指针（仅内存态） */
  activeWorkspaceId: string | null
  // 内部状态（用于防抖和请求管理）
  _refreshPromises: Map<string, Promise<void>>
  _refreshTimeouts: Map<string, NodeJS.Timeout>
}

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

export type GitState = StatusState & StatusActions

/** 状态 Slice Creator 类型 */
export type StatusSlice = StateCreator<GitState, [], [], StatusState & StatusActions>
