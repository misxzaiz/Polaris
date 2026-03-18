/**
 * advancedSlice 单元测试
 *
 * 测试 Git 高级操作 (Cherry-pick, Revert) 功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock Tauri invoke
const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createAdvancedSlice } from './advancedSlice'
import { createStatusSlice } from './statusSlice'
import type { GitState, StatusState, StatusActions } from './types'
import type { GitCherryPickResult, GitRevertResult, GitRepositoryStatus } from '@/types/git'

// 创建测试用的最小状态
type TestState = StatusState &
  StatusActions &
  Pick<GitState, 'branches' | 'remotes' | 'tags' | 'currentPR' | 'commits' | 'stashList'>

// 创建测试用的 store
function createTestStore() {
  return create<TestState>((...args) => ({
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
    stashList: [],

    // 应用 slice
    ...createStatusSlice(...args),
    ...createAdvancedSlice(...args),
  }))
}

describe('advancedSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('cherryPick', () => {
    const mockStatus: GitRepositoryStatus = {
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
    }

    it('应成功 Cherry-pick 提交', async () => {
      const mockResult: GitCherryPickResult = {
        success: true,
        message: 'Cherry-pick successful',
      }
      mockInvoke
        .mockResolvedValueOnce(mockResult) // git_cherry_pick
        .mockResolvedValueOnce(mockStatus) // refreshStatus

      const store = createTestStore()
      const result = await store.getState().cherryPick('/workspace', 'abc123')

      expect(mockInvoke).toHaveBeenCalledWith('git_cherry_pick', {
        workspacePath: '/workspace',
        commitSha: 'abc123',
      })
      expect(result.success).toBe(true)
      expect(store.getState().isLoading).toBe(false)
    })

    it('应正确处理 Cherry-pick 冲突', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('CONFLICT (content): Merge conflict'))

      const store = createTestStore()
      await expect(
        store.getState().cherryPick('/workspace', 'conflicting-commit')
      ).rejects.toThrow('CONFLICT')

      expect(store.getState().error).toContain('CONFLICT')
    })
  })

  describe('cherryPickAbort', () => {
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

    it('应成功中止 Cherry-pick', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // git_cherry_pick_abort
        .mockResolvedValueOnce(mockStatus) // refreshStatus

      const store = createTestStore()
      await store.getState().cherryPickAbort('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_cherry_pick_abort', {
        workspacePath: '/workspace',
      })
      expect(store.getState().isLoading).toBe(false)
    })

    it('应正确处理中止错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('No cherry-pick in progress'))

      const store = createTestStore()
      await expect(
        store.getState().cherryPickAbort('/workspace')
      ).rejects.toThrow('No cherry-pick in progress')
    })
  })

  describe('cherryPickContinue', () => {
    const mockStatus: GitRepositoryStatus = {
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
    }

    it('应成功继续 Cherry-pick', async () => {
      const mockResult: GitCherryPickResult = {
        success: true,
        message: 'Cherry-pick continued successfully',
      }
      mockInvoke
        .mockResolvedValueOnce(mockResult)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      const result = await store.getState().cherryPickContinue('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_cherry_pick_continue', {
        workspacePath: '/workspace',
      })
      expect(result.success).toBe(true)
    })

    it('应正确处理继续 Cherry-pick 时的错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Resolve conflicts first'))

      const store = createTestStore()
      await expect(
        store.getState().cherryPickContinue('/workspace')
      ).rejects.toThrow('Resolve conflicts first')
    })
  })

  describe('revert', () => {
    const mockStatus: GitRepositoryStatus = {
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
    }

    it('应成功 Revert 提交', async () => {
      const mockResult: GitRevertResult = {
        success: true,
        message: 'Revert successful',
      }
      mockInvoke
        .mockResolvedValueOnce(mockResult)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      const result = await store.getState().revert('/workspace', 'abc123')

      expect(mockInvoke).toHaveBeenCalledWith('git_revert', {
        workspacePath: '/workspace',
        commitSha: 'abc123',
      })
      expect(result.success).toBe(true)
      expect(store.getState().isLoading).toBe(false)
    })

    it('应正确处理 Revert 冲突', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('CONFLICT (content): Revert conflict'))

      const store = createTestStore()
      await expect(
        store.getState().revert('/workspace', 'conflicting-commit')
      ).rejects.toThrow('CONFLICT')

      expect(store.getState().error).toContain('CONFLICT')
    })
  })

  describe('revertAbort', () => {
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

    it('应成功中止 Revert', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().revertAbort('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_revert_abort', {
        workspacePath: '/workspace',
      })
      expect(store.getState().isLoading).toBe(false)
    })

    it('应正确处理中止错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('No revert in progress'))

      const store = createTestStore()
      await expect(
        store.getState().revertAbort('/workspace')
      ).rejects.toThrow('No revert in progress')
    })
  })

  describe('revertContinue', () => {
    const mockStatus: GitRepositoryStatus = {
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
    }

    it('应成功继续 Revert', async () => {
      const mockResult: GitRevertResult = {
        success: true,
        message: 'Revert continued successfully',
      }
      mockInvoke
        .mockResolvedValueOnce(mockResult)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      const result = await store.getState().revertContinue('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_revert_continue', {
        workspacePath: '/workspace',
      })
      expect(result.success).toBe(true)
    })

    it('应正确处理继续 Revert 时的错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Resolve conflicts first'))

      const store = createTestStore()
      await expect(
        store.getState().revertContinue('/workspace')
      ).rejects.toThrow('Resolve conflicts first')
    })
  })

  describe('状态同步', () => {
    it('Cherry-pick 成功后应刷新状态', async () => {
      const mockStatus: GitRepositoryStatus = {
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
      }
      const mockResult: GitCherryPickResult = {
        success: true,
        message: 'Done',
      }

      mockInvoke
        .mockResolvedValueOnce(mockResult)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().cherryPick('/workspace', 'abc123')

      expect(mockInvoke).toHaveBeenNthCalledWith(1, 'git_cherry_pick', expect.any(Object))
      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'git_get_status', expect.any(Object))
    })

    it('Revert 成功后应刷新状态', async () => {
      const mockStatus: GitRepositoryStatus = {
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
      }
      const mockResult: GitRevertResult = {
        success: true,
        message: 'Done',
      }

      mockInvoke
        .mockResolvedValueOnce(mockResult)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().revert('/workspace', 'abc123')

      expect(mockInvoke).toHaveBeenNthCalledWith(1, 'git_revert', expect.any(Object))
      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'git_get_status', expect.any(Object))
    })
  })
})
