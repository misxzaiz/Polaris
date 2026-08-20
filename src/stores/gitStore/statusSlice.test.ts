/**
 * statusSlice 单元测试
 *
 * 测试 Git 状态管理和 Diff 操作
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock Tauri invoke
const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createStatusSlice } from './statusSlice'
import type { GitState, StatusState, StatusActions } from './types'
import type { GitRepositoryStatus, GitDiffEntry } from '@/types/git'

// 创建测试用的最小状态
type TestState = StatusState & StatusActions & Pick<GitState, 'branches' | 'remotes' | 'tags' | 'currentPR' | 'commits' | 'stashList'>

// 创建测试用的 store
function createTestStore() {
  return create<TestState>((...args) => ({
    // 状态
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

    // 其他 slice 需要的状态
    branches: [],
    remotes: [],
    tags: [],
    currentPR: null,
    commits: [],
    stashList: [],

    // 应用 statusSlice
    ...createStatusSlice(...args),
  }))
}

describe('statusSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('应正确初始化所有状态', () => {
      const store = createTestStore()
      const state = store.getState()

      expect(state.status).toBeNull()
      expect(state.diffs).toEqual([])
      expect(state.worktreeDiffs).toEqual([])
      expect(state.indexDiffs).toEqual([])
      expect(state.isLoading).toBe(false)
      expect(state.error).toBeNull()
      expect(state.selectedFilePath).toBeNull()
      expect(state.selectedDiff).toBeNull()
    })
  })

  describe('refreshStatus', () => {
    it('应成功刷新仓库状态', async () => {
      const mockStatus: GitRepositoryStatus = {
        branch: 'main',
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicts: [],
        stashes: 0,
        isRebasing: false,
        isMerging: false,
        isCherryPicking: false,
        isReverting: false,
      }

      mockInvoke.mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().refreshStatus('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_get_status', {
        workspacePath: '/workspace',
      })
      expect(store.getState().status).toEqual(mockStatus)
      expect(store.getState().isLoading).toBe(false)
      expect(store.getState().error).toBeNull()
    })

    it('应正确处理刷新错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Not a git repository'))

      const store = createTestStore()
      await store.getState().refreshStatus('/workspace')

      expect(store.getState().status).toBeNull()
      expect(store.getState().error).toBe('Not a git repository')
      expect(store.getState().isLoading).toBe(false)
    })

    it('刷新时应设置 isLoading 为 true', async () => {
      let resolveInvoke: () => void
      mockInvoke.mockImplementation(() => new Promise((resolve) => {
        resolveInvoke = () => resolve({ branch: 'main', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicts: [], stashes: 0, isRebasing: false, isMerging: false, isCherryPicking: false, isReverting: false })
      }))

      const store = createTestStore()
      const promise = store.getState().refreshStatus('/workspace')

      // 此时 isLoading 应该是 true
      expect(store.getState().isLoading).toBe(true)

      resolveInvoke!()
      await promise

      expect(store.getState().isLoading).toBe(false)
    })
  })

  describe('refreshStatusDebounced', () => {
    it('应延迟执行刷新', async () => {
      const mockStatus: GitRepositoryStatus = {
        branch: 'main',
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicts: [],
        stashes: 0,
        isRebasing: false,
        isMerging: false,
        isCherryPicking: false,
        isReverting: false,
      }
      mockInvoke.mockResolvedValue(mockStatus)

      const store = createTestStore()
      const promise = store.getState().refreshStatusDebounced('/workspace', 500)

      // 500ms 内不应调用 invoke
      await vi.advanceTimersByTimeAsync(400)
      expect(mockInvoke).not.toHaveBeenCalled()

      // 500ms 后应调用 invoke
      await vi.advanceTimersByTimeAsync(100)
      expect(mockInvoke).toHaveBeenCalledWith('git_get_status', {
        workspacePath: '/workspace',
      })

      await promise
    })

    it('连续调用应取消之前的定时器', async () => {
      const mockStatus: GitRepositoryStatus = {
        branch: 'main',
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicts: [],
        stashes: 0,
        isRebasing: false,
        isMerging: false,
        isCherryPicking: false,
        isReverting: false,
      }
      mockInvoke.mockResolvedValue(mockStatus)

      const store = createTestStore()

      // 第一次调用 - 创建 500ms 定时器
      store.getState().refreshStatusDebounced('/workspace', 500)

      // 200ms 后再次调用 - 取消第一次定时器，创建新的 500ms 定时器
      await vi.advanceTimersByTimeAsync(200)
      store.getState().refreshStatusDebounced('/workspace', 500)

      // 此时不应该有调用（第二次定时器还需 500ms）
      expect(mockInvoke).not.toHaveBeenCalled()

      // 再过 500ms（从第二次调用开始算 500ms，总共 700ms）
      await vi.advanceTimersByTimeAsync(500)
      expect(mockInvoke).toHaveBeenCalledTimes(1)
    })
  })

  describe('getDiffs', () => {
    it('应获取 HEAD vs base commit 的 diff', async () => {
      const mockDiffs: GitDiffEntry[] = [
        { path: 'file1.ts', status: 'modified', hunks: [] },
        { path: 'file2.ts', status: 'added', hunks: [] },
      ]
      mockInvoke.mockResolvedValueOnce(mockDiffs)

      const store = createTestStore()
      await store.getState().getDiffs('/workspace', 'main')

      expect(mockInvoke).toHaveBeenCalledWith('git_get_diffs', {
        workspacePath: '/workspace',
        baseCommit: 'main',
      })
      expect(store.getState().diffs).toEqual(mockDiffs)
    })

    it('应处理获取 diff 错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Commit not found'))

      const store = createTestStore()
      await store.getState().getDiffs('/workspace', 'nonexistent')

      expect(store.getState().diffs).toEqual([])
      expect(store.getState().error).toBe('Commit not found')
    })
  })

  describe('getWorktreeDiff', () => {
    it('应获取工作区 diff', async () => {
      const mockDiffs: GitDiffEntry[] = [
        { path: 'modified.ts', status: 'modified', hunks: [] },
      ]
      mockInvoke.mockResolvedValueOnce(mockDiffs)

      const store = createTestStore()
      await store.getState().getWorktreeDiff('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_get_worktree_diff', {
        workspacePath: '/workspace',
      })
      expect(store.getState().worktreeDiffs).toEqual(mockDiffs)
    })

    it('应处理获取工作区 diff 错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Worktree error'))

      const store = createTestStore()
      await store.getState().getWorktreeDiff('/workspace')

      expect(store.getState().worktreeDiffs).toEqual([])
      expect(store.getState().error).toBe('Worktree error')
    })
  })

  describe('getIndexDiff', () => {
    it('应获取暂存区 diff', async () => {
      const mockDiffs: GitDiffEntry[] = [
        { path: 'staged.ts', status: 'added', hunks: [] },
      ]
      mockInvoke.mockResolvedValueOnce(mockDiffs)

      const store = createTestStore()
      await store.getState().getIndexDiff('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_get_index_diff', {
        workspacePath: '/workspace',
      })
      expect(store.getState().indexDiffs).toEqual(mockDiffs)
    })

    it('应处理获取暂存区 diff 错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Index error'))

      const store = createTestStore()
      await store.getState().getIndexDiff('/workspace')

      expect(store.getState().indexDiffs).toEqual([])
      expect(store.getState().error).toBe('Index error')
    })
  })

  describe('getIndexFileDiff', () => {
    it('应获取单个文件的暂存区 diff', async () => {
      const mockDiff: GitDiffEntry = {
        path: 'staged-file.ts',
        status: 'added',
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 5, content: '@@ -0,0 +1,5 @@' }],
      }
      mockInvoke.mockResolvedValueOnce(mockDiff)

      const store = createTestStore()
      const result = await store.getState().getIndexFileDiff('/workspace', 'staged-file.ts')

      expect(mockInvoke).toHaveBeenCalledWith('git_get_index_file_diff', {
        workspacePath: '/workspace',
        filePath: 'staged-file.ts',
      })
      expect(result).toEqual(mockDiff)
    })

    it('应抛出解析后的错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('File not staged'))

      const store = createTestStore()
      await expect(
        store.getState().getIndexFileDiff('/workspace', 'not-staged.ts')
      ).rejects.toThrow('File not staged')
    })

    it('应处理对象形式的错误', async () => {
      mockInvoke.mockRejectedValueOnce({ message: 'Unknown error', details: 'extra info' })

      const store = createTestStore()
      await expect(
        store.getState().getIndexFileDiff('/workspace', 'file.ts')
      ).rejects.toThrow('Unknown error (extra info)')
    })
  })

  describe('getWorktreeFileDiff', () => {
    it('应获取单个文件的工作区 diff', async () => {
      const mockDiff: GitDiffEntry = {
        path: 'file.ts',
        status: 'modified',
        hunks: [],
      }
      mockInvoke.mockResolvedValueOnce(mockDiff)

      const store = createTestStore()
      const result = await store.getState().getWorktreeFileDiff('/workspace', 'file.ts')

      expect(mockInvoke).toHaveBeenCalledWith('git_get_worktree_file_diff', {
        workspacePath: '/workspace',
        filePath: 'file.ts',
      })
      expect(result).toEqual(mockDiff)
    })

    it('应抛出解析后的错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('File not found'))

      const store = createTestStore()
      await expect(
        store.getState().getWorktreeFileDiff('/workspace', 'missing.ts')
      ).rejects.toThrow('File not found')
    })
  })

  describe('getChangedFiles', () => {
    it('无状态时应返回空数组', () => {
      const store = createTestStore()
      expect(store.getState().getChangedFiles()).toEqual([])
    })

    it('应返回所有变更文件路径', () => {
      const store = createTestStore()
      store.setState({
        status: {
          branch: 'main',
          ahead: 0,
          behind: 0,
          staged: [{ path: 'staged.ts', status: 'modified' }],
          unstaged: [{ path: 'unstaged.ts', status: 'modified' }],
          untracked: ['untracked.ts'],
          conflicts: [],
          stashes: 0,
          isRebasing: false,
          isMerging: false,
          isCherryPicking: false,
          isReverting: false,
        },
      })

      const files = store.getState().getChangedFiles()
      expect(files).toContain('staged.ts')
      expect(files).toContain('unstaged.ts')
      expect(files).toContain('untracked.ts')
      expect(files).toHaveLength(3)
    })

    it('应正确处理重复文件路径（staged 和 unstaged 同一文件）', () => {
      const store = createTestStore()
      store.setState({
        status: {
          branch: 'main',
          ahead: 0,
          behind: 0,
          staged: [{ path: 'file.ts', status: 'modified' }],
          unstaged: [{ path: 'file.ts', status: 'modified' }],
          untracked: [],
          conflicts: [],
          stashes: 0,
          isRebasing: false,
          isMerging: false,
          isCherryPicking: false,
          isReverting: false,
        },
      })

      const files = store.getState().getChangedFiles()
      // 允许重复（部分暂存的情况）
      expect(files).toEqual(['file.ts', 'file.ts'])
    })
  })

  describe('hasChanges', () => {
    it('无状态时应返回 false', () => {
      const store = createTestStore()
      expect(store.getState().hasChanges()).toBe(false)
    })

    it('有 staged 文件时应返回 true', () => {
      const store = createTestStore()
      store.setState({
        status: {
          branch: 'main',
          ahead: 0,
          behind: 0,
          staged: [{ path: 'file.ts', status: 'modified' }],
          unstaged: [],
          untracked: [],
          conflicts: [],
          stashes: 0,
          isRebasing: false,
          isMerging: false,
          isCherryPicking: false,
          isReverting: false,
        },
      })
      expect(store.getState().hasChanges()).toBe(true)
    })

    it('有 unstaged 文件时应返回 true', () => {
      const store = createTestStore()
      store.setState({
        status: {
          branch: 'main',
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [{ path: 'file.ts', status: 'modified' }],
          untracked: [],
          conflicts: [],
          stashes: 0,
          isRebasing: false,
          isMerging: false,
          isCherryPicking: false,
          isReverting: false,
        },
      })
      expect(store.getState().hasChanges()).toBe(true)
    })

    it('有 untracked 文件时应返回 true', () => {
      const store = createTestStore()
      store.setState({
        status: {
          branch: 'main',
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [],
          untracked: ['new-file.ts'],
          conflicts: [],
          stashes: 0,
          isRebasing: false,
          isMerging: false,
          isCherryPicking: false,
          isReverting: false,
        },
      })
      expect(store.getState().hasChanges()).toBe(true)
    })

    it('无任何变更时应返回 false', () => {
      const store = createTestStore()
      store.setState({
        status: {
          branch: 'main',
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [],
          untracked: [],
          conflicts: [],
          stashes: 0,
          isRebasing: false,
          isMerging: false,
          isCherryPicking: false,
          isReverting: false,
        },
      })
      expect(store.getState().hasChanges()).toBe(false)
    })
  })

  describe('clearError', () => {
    it('应清除错误状态', () => {
      const store = createTestStore()
      store.setState({ error: 'Some error' })

      store.getState().clearError()

      expect(store.getState().error).toBeNull()
    })
  })

  describe('clearAll', () => {
    it('应清除所有状态', () => {
      const store = createTestStore()
      store.setState({
        status: {
          branch: 'main',
          ahead: 1,
          behind: 0,
          staged: [],
          unstaged: [],
          untracked: [],
          conflicts: [],
          stashes: 0,
          isRebasing: false,
          isMerging: false,
          isCherryPicking: false,
          isReverting: false,
        },
        diffs: [{ path: 'file.ts', status: 'modified', hunks: [] }],
        error: 'Previous error',
        selectedFilePath: 'file.ts',
      })

      store.getState().clearAll()

      const state = store.getState()
      expect(state.status).toBeNull()
      expect(state.diffs).toEqual([])
      expect(state.worktreeDiffs).toEqual([])
      expect(state.indexDiffs).toEqual([])
      expect(state.branches).toEqual([])
      expect(state.remotes).toEqual([])
      expect(state.tags).toEqual([])
      expect(state.error).toBeNull()
      expect(state.selectedFilePath).toBeNull()
      expect(state.selectedDiff).toBeNull()
    })
  })

  describe('UI 状态方法', () => {
    it('setSelectedFilePath 应正确设置选中文件', () => {
      const store = createTestStore()

      store.getState().setSelectedFilePath('src/file.ts')
      expect(store.getState().selectedFilePath).toBe('src/file.ts')

      store.getState().setSelectedFilePath(null)
      expect(store.getState().selectedFilePath).toBeNull()
    })

    it('setSelectedDiff 应正确设置选中 diff', () => {
      const store = createTestStore()
      const mockDiff: GitDiffEntry = {
        path: 'file.ts',
        status: 'modified',
        hunks: [],
      }

      store.getState().setSelectedDiff(mockDiff)
      expect(store.getState().selectedDiff).toEqual(mockDiff)

      store.getState().setSelectedDiff(null)
      expect(store.getState().selectedDiff).toBeNull()
    })
  })
})
