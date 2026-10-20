/**
 * 状态数据 Slice
 *
 * 负责状态管理、Diff 操作和 UI 状态
 */

import { invoke } from '@/services/transport'
import type { StatusSlice } from './types'
import { parseGitError } from './types'
import type { GitDiffEntry, GitDiscoveredRepo } from '@/types/git'
import { createLogger } from '@/utils/logger'

const log = createLogger('GitStore')

/**
 * 创建状态数据 Slice
 */
export const createStatusSlice: StatusSlice = (set, get) => ({
  // ===== 状态 =====
  status: null,
  /** 按仓库路径键控的状态缓存。多仓库/多面板场景下各路径互不覆盖 */
  statuses: {},
  /** 每个仓库路径的刷新序号，用于丢弃乱序返回的旧请求 */
  _statusSeq: {},
  diffs: [],
  worktreeDiffs: [],
  indexDiffs: [],
  isLoading: false,
  error: null,
  selectedFilePath: null,
  selectedDiff: null,
  discoveredRepos: [],
  isDiscovering: false,
  pinnedRepos: [],
  activeWorkspaceId: null,
  _refreshPromises: new Map(),
  _refreshTimeouts: new Map(),

  // ===== 方法 =====

  // 刷新仓库状态
  async refreshStatus(workspacePath: string) {
    log.debug('refreshStatus start', { workspacePath })
    set({ isLoading: true, error: null })

    // per-path 序号：后发出的请求具有更大序号，先发出的旧请求返回后直接丢弃
    const seq = (get()._statusSeq[workspacePath] ?? 0) + 1
    set({ _statusSeq: { ...get()._statusSeq, [workspacePath]: seq } })

    try {
      log.debug('Calling git_get_status', { workspacePath })
      const status = await invoke<import('@/types/git').GitRepositoryStatus>('git_get_status', {
        workspacePath,
      })

      // 该路径已有更新的请求发出，本次结果已过期，丢弃
      if ((get()._statusSeq[workspacePath] ?? 0) !== seq) {
        log.debug('refreshStatus stale result dropped', { workspacePath, seq })
        return
      }

      log.debug('git_get_status success', { status })
      set({
        status,
        statuses: { ...get().statuses, [workspacePath]: status },
        isLoading: false,
      })
    } catch (err) {
      const message = parseGitError(err)
      log.error('git_get_status failed', err instanceof Error ? err : new Error(String(err)), {
        workspacePath,
      })
      // 过期请求的错误同样丢弃，避免污染新请求的展示
      if ((get()._statusSeq[workspacePath] ?? 0) !== seq) {
        return
      }
      set({
        error: message,
        isLoading: false,
        status: null,
        statuses: { ...get().statuses, [workspacePath]: null },
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

  // 扫描工作区下所有嵌套 Git 子仓库
  async discoverRepositories(workspacePath: string, maxDepth?: number) {
    set({ isDiscovering: true })
    try {
      const repos = await invoke<GitDiscoveredRepo[]>('git_discover_repositories', {
        workspacePath,
        maxDepth,
      })
      set({ discoveredRepos: repos, isDiscovering: false })
      return repos
    } catch (err) {
      const message = parseGitError(err)
      log.error('git_discover_repositories failed', err instanceof Error ? err : new Error(String(err)), {
        workspacePath,
      })
      set({ isDiscovering: false, discoveredRepos: [], error: message })
      return []
    }
  },

  // 切换某子仓库的置顶状态
  togglePinnedRepo(workspacePath: string, repoPath: string) {
    const STORAGE_KEY = `polaris:git:pinned-repos:${workspacePath}`
    const current = get().pinnedRepos
    const next = current.includes(repoPath)
      ? current.filter((p) => p !== repoPath)
      : [...current, repoPath]
    set({ pinnedRepos: next })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // localStorage 不可用时静默降级（仅内存态）
    }
  },

  // 查询某子仓库是否已置顶
  isPinnedRepo(repoPath: string) {
    return get().pinnedRepos.includes(repoPath)
  },

  // 从 localStorage 加载指定工作区的置顶列表
  loadPinnedRepos(workspacePath: string) {
    const STORAGE_KEY = `polaris:git:pinned-repos:${workspacePath}`
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const arr = raw ? (JSON.parse(raw) as string[]) : []
      set({ pinnedRepos: Array.isArray(arr) ? arr : [] })
    } catch {
      set({ pinnedRepos: [] })
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
      statuses: {},
      _statusSeq: {},
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
      discoveredRepos: [],
      isDiscovering: false,
      pinnedRepos: [],
      activeWorkspaceId: null,
      _refreshPromises: new Map(),
      _refreshTimeouts: new Map(),
    })
  },

  // 检查是否有变更（可指定仓库路径，缺省使用全局 status）
  hasChanges(workspacePath?: string) {
    const status = workspacePath ? get().statuses[workspacePath] : get().status
    if (!status) return false

    return (
      status.staged.length > 0 ||
      status.unstaged.length > 0 ||
      status.untracked.length > 0
    )
  },

  // 获取所有变更文件（可指定仓库路径，缺省使用全局 status）
  getChangedFiles(workspacePath?: string) {
    const status = workspacePath ? get().statuses[workspacePath] : get().status
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

  // 设置 Git 面板独立工作区（仅内存态，不影响 FileExplorer 浏览状态）
  setActiveWorkspaceId(id: string | null) {
    set({ activeWorkspaceId: id })
  },
})
