/**
 * stashSlice 单元测试
 *
 * 测试 Git Stash 操作功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock Tauri invoke
const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createStashSlice } from './stashSlice'
import { createStatusSlice } from './statusSlice'
import type { GitState, StashState, StashActions, StatusState, StatusActions } from './types'
import type { GitStashEntry, GitRepositoryStatus } from '@/types/git'

// 创建测试用的最小状态
type TestState = StashState &
  StashActions &
  StatusState &
  StatusActions &
  Pick<GitState, 'branches' | 'remotes' | 'tags' | 'currentPR' | 'commits'>

// 创建测试用的 store
function createTestStore() {
  return create<TestState>((...args) => ({
    // Stash 状态
    stashList: [],

    // 状态数据
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

    // 应用 slice
    ...createStatusSlice(...args),
    ...createStashSlice(...args),
  }))
}

// 创建模拟的 Stash 数据
function createMockStashEntry(index: number, message: string): GitStashEntry {
  return {
    index,
    message,
    branch: 'main',
    commitSha: `stash${index}`,
    date: new Date().toISOString(),
  }
}

describe('stashSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('应正确初始化 Stash 列表为空数组', () => {
      const store = createTestStore()
      expect(store.getState().stashList).toEqual([])
    })
  })

  describe('getStashList', () => {
    it('应成功获取 Stash 列表', async () => {
      const mockStashList: GitStashEntry[] = [
        createMockStashEntry(0, 'WIP on main: abc123'),
        createMockStashEntry(1, 'WIP on feature: def456'),
      ]
      mockInvoke.mockResolvedValueOnce(mockStashList)

      const store = createTestStore()
      const result = await store.getState().getStashList('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_stash_list', {
        workspacePath: '/workspace',
      })
      expect(store.getState().stashList).toEqual(mockStashList)
      expect(result).toEqual(mockStashList)
    })

    it('无 stash 时应返回空数组', async () => {
      mockInvoke.mockResolvedValueOnce([])

      const store = createTestStore()
      const result = await store.getState().getStashList('/workspace')

      expect(result).toEqual([])
    })

    it('应正确处理获取 Stash 列表错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Not a git repository'))

      const store = createTestStore()
      const result = await store.getState().getStashList('/workspace')

      expect(result).toEqual([])
      expect(store.getState().error).toBe('Not a git repository')
    })
  })

  describe('stashSave', () => {
    const mockStatus: GitRepositoryStatus = {
      branch: 'main',
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      conflicts: [],
      stashes: 1,
      isRebasing: false,
      isMerging: false,
      isCherryPicking: false,
      isReverting: false,
    }

    it('应成功保存 Stash', async () => {
      mockInvoke
        .mockResolvedValueOnce('stash@{0}') // git_stash_save
        .mockResolvedValueOnce(mockStatus) // refreshStatus

      const store = createTestStore()
      const result = await store.getState().stashSave('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_stash_save', {
        workspacePath: '/workspace',
        message: null,
        includeUntracked: false,
      })
      expect(result).toBe('stash@{0}')
      expect(store.getState().isLoading).toBe(false)
    })

    it('应支持带消息保存 Stash', async () => {
      mockInvoke
        .mockResolvedValueOnce('stash@{0}')
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().stashSave('/workspace', 'Work in progress')

      expect(mockInvoke).toHaveBeenCalledWith('git_stash_save', {
        workspacePath: '/workspace',
        message: 'Work in progress',
        includeUntracked: false,
      })
    })

    it('应支持包含未跟踪文件', async () => {
      mockInvoke
        .mockResolvedValueOnce('stash@{0}')
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().stashSave('/workspace', undefined, true)

      expect(mockInvoke).toHaveBeenCalledWith('git_stash_save', {
        workspacePath: '/workspace',
        message: null,
        includeUntracked: true,
      })
    })

    it('应正确处理保存 Stash 错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('No local changes to save'))

      const store = createTestStore()
      await expect(
        store.getState().stashSave('/workspace')
      ).rejects.toThrow('No local changes to save')

      expect(store.getState().error).toBe('No local changes to save')
    })
  })

  describe('stashPop', () => {
    const mockStatus: GitRepositoryStatus = {
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
    }

    it('应成功应用最新的 Stash', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // git_stash_pop
        .mockResolvedValueOnce(mockStatus) // refreshStatus

      const store = createTestStore()
      await store.getState().stashPop('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_stash_pop', {
        workspacePath: '/workspace',
        index: null,
      })
      expect(store.getState().isLoading).toBe(false)
    })

    it('应支持应用指定索引的 Stash', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().stashPop('/workspace', 2)

      expect(mockInvoke).toHaveBeenCalledWith('git_stash_pop', {
        workspacePath: '/workspace',
        index: 2,
      })
    })

    it('应正确处理应用 Stash 错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('CONFLICTS: content conflict'))

      const store = createTestStore()
      await expect(
        store.getState().stashPop('/workspace')
      ).rejects.toThrow('CONFLICTS')

      expect(store.getState().error).toContain('CONFLICTS')
    })
  })

  describe('stashDrop', () => {
    it('应成功删除指定 Stash', async () => {
      const remainingStashList: GitStashEntry[] = [
        createMockStashEntry(0, 'WIP on main: def456'),
      ]
      mockInvoke
        .mockResolvedValueOnce(undefined) // git_stash_drop
        .mockResolvedValueOnce(remainingStashList) // git_stash_list

      const store = createTestStore()
      await store.getState().stashDrop('/workspace', 1)

      expect(mockInvoke).toHaveBeenCalledWith('git_stash_drop', {
        workspacePath: '/workspace',
        index: 1,
      })
      expect(store.getState().stashList).toEqual(remainingStashList)
      expect(store.getState().isLoading).toBe(false)
    })

    it('应正确处理删除 Stash 错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('stash@{5} is not a valid reference'))

      const store = createTestStore()
      await expect(
        store.getState().stashDrop('/workspace', 5)
      ).rejects.toThrow('not a valid reference')

      expect(store.getState().error).toContain('not a valid reference')
    })
  })

  describe('状态同步', () => {
    it('保存 Stash 后应刷新状态', async () => {
      const mockStatus: GitRepositoryStatus = {
        branch: 'main',
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicts: [],
        stashes: 1,
        isRebasing: false,
        isMerging: false,
        isCherryPicking: false,
        isReverting: false,
      }

      mockInvoke
        .mockResolvedValueOnce('stash@{0}')
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().stashSave('/workspace')

      expect(mockInvoke).toHaveBeenNthCalledWith(1, 'git_stash_save', expect.any(Object))
      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'git_get_status', expect.any(Object))

      expect(store.getState().status?.stashes).toBe(1)
    })
  })
})
