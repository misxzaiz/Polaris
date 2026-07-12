/**
 * 状态数据 Slice
 *
 * 负责状态管理、Diff 操作和 UI 状态
 */

import { invoke } from '@/services/transport'
import type { StatusSlice } from './types'
import { parseGitError } from './types'
import type { GitDiffEntry } from '@/types/git'
import { createLogger } from '@/utils/logger'

const log = createLogger('GitStore')

/**
 * 创建状态数据 Slice
 */
export const createStatusSlice: StatusSlice = (set, get) => ({
  // ===== 状态 =====
  status: null,
  diffs: [],
  worktreeDiffs: [],
  indexDiffs: [],
  isLoading: false,
  error: null,
  selectedFilePath: null,
  selectedDiff: null,
  _refreshPromises: new Map(),
  _refreshTimeouts: new Map(),

  // ===== 方法 =====

  // 刷新仓库状态
  async refreshStatus(workspacePath: string) {
    log.debug('refreshStatus start', { workspacePath })
    set({ isLoading: true, error: null })

    try {
      log.debug('Calling git_get_status', { workspacePath })
      const status = await invoke<import('@/types/git').GitRepositoryStatus>('git_get_status', {
        workspacePath,
      })

      log.debug('git_get_status success', { status })
      set({ status, isLoading: false })
    } catch (err) {
      const message = parseGitError(err)
      log.error('git_get_status failed', err instanceof Error ? err : new Error(String(err)), {
        workspacePath,
      })
      set({
        error: message,
        isLoading: false,
        status: null,
      })
    }
  },

  // 防抖的 Git 状态刷新
  async refreshStatusDebounced(workspacePath: string, delay = 500) {
    const state = get()

    // 清除已有的定时器
    const existingTimeout = state._refreshTimeouts.get(workspacePath)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
      state._refreshTimeouts.delete(workspacePath)
    }

    // 创建新的防抖Promise
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(async () => {
        try {
          await get().refreshStatus(workspacePath)
        } finally {
          // 清理
          const currentState = get()
          currentState._refreshTimeouts.delete(workspacePath)
          currentState._refreshPromises.delete(workspacePath)
          resolve()
        }
      }, delay)

      // 保存定时器和Promise
      set({
        _refreshTimeouts: new Map(state._refreshTimeouts).set(workspacePath, timeout)
      })
    })
  },

  // 获取 Diff (HEAD vs base commit)
  async getDiffs(workspacePath: string, baseCommit: string) {
    set({ isLoading: true, error: null })

    try {
      const diffs = await invoke<GitDiffEntry[]>('git_get_diffs', {
        workspacePath,
        baseCommit,
      })

      set({ diffs, isLoading: false })
    } catch (err) {
      const message = parseGitError(err)
      set({
        error: message,
        isLoading: false,
        diffs: [],
      })
    }
  },

  // 获取工作区 Diff
  async getWorktreeDiff(workspacePath: string) {
    set({ isLoading: true, error: null })

    try {
      const diffs = await invoke<GitDiffEntry[]>('git_get_worktree_diff', {
        workspacePath,
      })

      set({ worktreeDiffs: diffs, isLoading: false })
    } catch (err) {
      const message = parseGitError(err)
      set({
        error: message,
        isLoading: false,
        worktreeDiffs: [],
      })
    }
  },

  // 获取暂存区 Diff
  async getIndexDiff(workspacePath: string) {
    set({ isLoading: true, error: null })

    try {
      const diffs = await invoke<GitDiffEntry[]>('git_get_index_diff', {
        workspacePath,
      })

      set({ indexDiffs: diffs, isLoading: false })
    } catch (err) {
      const message = parseGitError(err)
      set({
        error: message,
        isLoading: false,
        indexDiffs: [],
      })
    }
  },

  // 获取单个文件在工作区的 Diff
  async getWorktreeFileDiff(workspacePath: string, filePath: string) {
    try {
      return await invoke<GitDiffEntry>('git_get_worktree_file_diff', {
        workspacePath,
        filePath,
      })
    } catch (err) {
      throw new Error(parseGitError(err))
    }
  },

  // 获取单个文件在暂存区的 Diff
  async getIndexFileDiff(workspacePath: string, filePath: string) {
    try {
      return await invoke<GitDiffEntry>('git_get_index_file_diff', {
        workspacePath,
        filePath,
      })
    } catch (err) {
      throw new Error(parseGitError(err))
    }
  },

  // 清除错误
  clearError() {
    set({ error: null })
  },

  // 清除所有状态
  clearAll() {
    // 清理定时器
    const state = get()
    state._refreshTimeouts.forEach((timeout) => clearTimeout(timeout))

    set({
      status: null,
      diffs: [],
      worktreeDiffs: [],
      indexDiffs: [],
      branches: [],
      remotes: [],
      tags: [],
      currentPR: null,
      commits: [],
      commitDetails: {},
      stashList: [],
      error: null,
      selectedFilePath: null,
      selectedDiff: null,
      _refreshPromises: new Map(),
      _refreshTimeouts: new Map(),
    })
  },

  // 检查是否有变更
  hasChanges() {
    const { status } = get()
    if (!status) return false

    return (
      status.staged.length > 0 ||
      status.unstaged.length > 0 ||
      status.untracked.length > 0
    )
  },

  // 获取所有变更文件
  getChangedFiles() {
    const { status } = get()
    if (!status) return []

    return [
      ...status.staged.map((f) => f.path),
      ...status.unstaged.map((f) => f.path),
      ...status.untracked,
    ]
  },

  // 设置选中的文件
  setSelectedFilePath(path: string | null) {
    set({ selectedFilePath: path })
  },

  // 设置选中的 Diff
  setSelectedDiff(diff: GitDiffEntry | null) {
    set({ selectedDiff: diff })
  },
})
