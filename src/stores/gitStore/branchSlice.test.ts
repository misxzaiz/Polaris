/**
 * branchSlice 单元测试
 *
 * 测试 Git 分支操作功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock Tauri invoke
const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createBranchSlice } from './branchSlice'
import { createStatusSlice } from './statusSlice'
import type { GitState, BranchState, BranchActions, StatusState, StatusActions } from './types'
import type { GitBranch, GitMergeResult, GitRebaseResult, GitRepositoryStatus } from '@/types/git'

// 创建测试用的最小状态
type TestState = BranchState &
  BranchActions &
  StatusState &
  StatusActions &
  Pick<GitState, 'remotes' | 'tags' | 'currentPR' | 'commits' | 'stashList'>

// 创建测试用的 store
function createTestStore() {
  return create<TestState>((...args) => ({
    // 分支状态
    branches: [],

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
    remotes: [],
    tags: [],
    currentPR: null,
    commits: [],
    stashList: [],

    // 应用 slice
    ...createStatusSlice(...args),
    ...createBranchSlice(...args),
  }))
}

// 创建模拟的分支数据
function createMockBranch(name: string, isCurrent = false): GitBranch {
  return {
    name,
    isCurrent,
    upstream: null,
    ahead: 0,
    behind: 0,
    lastCommit: {
      sha: 'abc123',
      message: `Commit on ${name}`,
      author: 'Test Author',
      date: new Date().toISOString(),
    },
  }
}

describe('branchSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('应正确初始化分支列表为空数组', () => {
      const store = createTestStore()
      expect(store.getState().branches).toEqual([])
    })
  })

  describe('getBranches', () => {
    it('应成功获取分支列表', async () => {
      const mockBranches: GitBranch[] = [
        createMockBranch('main', true),
        createMockBranch('develop', false),
        createMockBranch('feature/test', false),
      ]
      mockInvoke.mockResolvedValueOnce(mockBranches)

      const store = createTestStore()
      await store.getState().getBranches('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_get_branches', {
        workspacePath: '/workspace',
      })
      expect(store.getState().branches).toEqual(mockBranches)
    })

    it('应正确处理获取分支错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Not a git repository'))

      const store = createTestStore()
      await store.getState().getBranches('/workspace')

      expect(store.getState().branches).toEqual([])
      expect(store.getState().error).toBe('Not a git repository')
    })
  })

  describe('createBranch', () => {
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

    it('应成功创建分支（不切换）', async () => {
      const mockBranches: GitBranch[] = [
        createMockBranch('main', true),
        createMockBranch('new-branch', false),
      ]

      mockInvoke
        .mockResolvedValueOnce(undefined) // git_create_branch
        .mockResolvedValueOnce(mockStatus) // refreshStatus
        .mockResolvedValueOnce(mockBranches) // getBranches

      const store = createTestStore()
      await store.getState().createBranch('/workspace', 'new-branch', false)

      expect(mockInvoke).toHaveBeenCalledWith('git_create_branch', {
        workspacePath: '/workspace',
        name: 'new-branch',
        checkout: false,
      })
      expect(store.getState().isLoading).toBe(false)
    })

    it('应成功创建并切换到新分支', async () => {
      const mockBranches: GitBranch[] = [
        createMockBranch('main', false),
        createMockBranch('new-branch', true),
      ]

      mockInvoke
        .mockResolvedValueOnce(undefined) // git_create_branch
        .mockResolvedValueOnce({ ...mockStatus, branch: 'new-branch' }) // refreshStatus
        .mockResolvedValueOnce(mockBranches) // getBranches

      const store = createTestStore()
      await store.getState().createBranch('/workspace', 'new-branch', true)

      expect(mockInvoke).toHaveBeenCalledWith('git_create_branch', {
        workspacePath: '/workspace',
        name: 'new-branch',
        checkout: true,
      })
    })

    it('应正确处理创建分支错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Branch already exists'))

      const store = createTestStore()
      await expect(
        store.getState().createBranch('/workspace', 'existing-branch')
      ).rejects.toThrow('Branch already exists')

      expect(store.getState().error).toBe('Branch already exists')
      expect(store.getState().isLoading).toBe(false)
    })
  })

  describe('deleteBranch', () => {
    const mockBranches: GitBranch[] = [
      createMockBranch('main', true),
      createMockBranch('feature', false),
    ]

    it('应成功删除分支', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // git_delete_branch
        .mockResolvedValueOnce([mockBranches[0]]) // getBranches

      const store = createTestStore()
      await store.getState().deleteBranch('/workspace', 'feature')

      expect(mockInvoke).toHaveBeenCalledWith('git_delete_branch', {
        workspacePath: '/workspace',
        name: 'feature',
        force: false,
      })
      expect(store.getState().isLoading).toBe(false)
    })

    it('应支持强制删除分支', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // git_delete_branch
        .mockResolvedValueOnce([mockBranches[0]]) // getBranches

      const store = createTestStore()
      await store.getState().deleteBranch('/workspace', 'unmerged-branch', true)

      expect(mockInvoke).toHaveBeenCalledWith('git_delete_branch', {
        workspacePath: '/workspace',
        name: 'unmerged-branch',
        force: true,
      })
    })

    it('应正确处理删除分支错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Cannot delete current branch'))

      const store = createTestStore()
      await expect(
        store.getState().deleteBranch('/workspace', 'main')
      ).rejects.toThrow('Cannot delete current branch')

      expect(store.getState().error).toBe('Cannot delete current branch')
    })
  })

  describe('renameBranch', () => {
    it('应成功重命名分支', async () => {
      const mockBranches: GitBranch[] = [
        createMockBranch('new-name', true),
      ]

      mockInvoke
        .mockResolvedValueOnce(undefined) // git_rename_branch
        .mockResolvedValueOnce({ branch: 'new-name' } as GitRepositoryStatus) // refreshStatus
        .mockResolvedValueOnce(mockBranches) // getBranches

      const store = createTestStore()
      await store.getState().renameBranch('/workspace', 'old-name', 'new-name')

      expect(mockInvoke).toHaveBeenCalledWith('git_rename_branch', {
        workspacePath: '/workspace',
        oldName: 'old-name',
        newName: 'new-name',
      })
    })

    it('应正确处理重命名错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Branch not found'))

      const store = createTestStore()
      await expect(
        store.getState().renameBranch('/workspace', 'nonexistent', 'new-name')
      ).rejects.toThrow('Branch not found')
    })
  })

  describe('checkoutBranch', () => {
    it('应成功切换分支', async () => {
      const mockBranches: GitBranch[] = [
        createMockBranch('main', false),
        createMockBranch('develop', true),
      ]

      mockInvoke
        .mockResolvedValueOnce(undefined) // git_checkout_branch
        .mockResolvedValueOnce({ branch: 'develop' } as GitRepositoryStatus) // refreshStatus
        .mockResolvedValueOnce(mockBranches) // getBranches

      const store = createTestStore()
      await store.getState().checkoutBranch('/workspace', 'develop')

      expect(mockInvoke).toHaveBeenCalledWith('git_checkout_branch', {
        workspacePath: '/workspace',
        name: 'develop',
      })
    })

    it('应正确处理切换分支错误', async () => {
      mockInvoke.mockRejectedValueOnce(
        new Error('Your local changes would be overwritten by checkout')
      )

      const store = createTestStore()
      await expect(
        store.getState().checkoutBranch('/workspace', 'other-branch')
      ).rejects.toThrow('Your local changes would be overwritten by checkout')
    })
  })

  describe('mergeBranch', () => {
    it('应成功合并分支', async () => {
      const mockResult: GitMergeResult = {
        success: true,
        message: 'Merge made by the recursive strategy.',
      }

      mockInvoke
        .mockResolvedValueOnce(mockResult) // git_merge_branch
        .mockResolvedValueOnce({ branch: 'main' } as GitRepositoryStatus) // refreshStatus
        .mockResolvedValueOnce([]) // getBranches

      const store = createTestStore()
      const result = await store.getState().mergeBranch('/workspace', 'feature')

      expect(mockInvoke).toHaveBeenCalledWith('git_merge_branch', {
        workspacePath: '/workspace',
        sourceBranch: 'feature',
        noFF: false,
      })
      expect(result).toEqual(mockResult)
    })

    it('应支持 no-ff 合并', async () => {
      const mockResult: GitMergeResult = {
        success: true,
        message: 'Merge made by the recursive strategy.',
      }

      mockInvoke
        .mockResolvedValueOnce(mockResult)
        .mockResolvedValueOnce({ branch: 'main' } as GitRepositoryStatus)
        .mockResolvedValueOnce([])

      const store = createTestStore()
      await store.getState().mergeBranch('/workspace', 'feature', true)

      expect(mockInvoke).toHaveBeenCalledWith('git_merge_branch', {
        workspacePath: '/workspace',
        sourceBranch: 'feature',
        noFF: true,
      })
    })

    it('应正确处理合并冲突', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('CONFLICTS: content conflict in file.ts'))

      const store = createTestStore()
      await expect(
        store.getState().mergeBranch('/workspace', 'conflicting-branch')
      ).rejects.toThrow('CONFLICTS')
    })
  })

  describe('rebaseBranch', () => {
    it('应成功变基分支', async () => {
      const mockResult: GitRebaseResult = {
        success: true,
        message: 'Successfully rebased and updated refs/heads/feature.',
      }

      mockInvoke
        .mockResolvedValueOnce(mockResult)
        .mockResolvedValueOnce({ branch: 'feature' } as GitRepositoryStatus)
        .mockResolvedValueOnce([])

      const store = createTestStore()
      const result = await store.getState().rebaseBranch('/workspace', 'main')

      expect(mockInvoke).toHaveBeenCalledWith('git_rebase_branch', {
        workspacePath: '/workspace',
        sourceBranch: 'main',
      })
      expect(result).toEqual(mockResult)
    })

    it('应正确处理变基冲突', async () => {
      mockInvoke.mockRejectedValueOnce(
        new Error('CONFLICT (content): Merge conflict in file.ts')
      )

      const store = createTestStore()
      await expect(
        store.getState().rebaseBranch('/workspace', 'main')
      ).rejects.toThrow('CONFLICT')
    })
  })

  describe('rebaseAbort', () => {
    it('应成功中止变基', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // git_rebase_abort
        .mockResolvedValueOnce({ branch: 'main' } as GitRepositoryStatus) // refreshStatus

      const store = createTestStore()
      await store.getState().rebaseAbort('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_rebase_abort', {
        workspacePath: '/workspace',
      })
    })

    it('应正确处理中止变基错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('No rebase in progress'))

      const store = createTestStore()
      await expect(
        store.getState().rebaseAbort('/workspace')
      ).rejects.toThrow('No rebase in progress')
    })
  })

  describe('rebaseContinue', () => {
    it('应成功继续变基', async () => {
      const mockResult: GitRebaseResult = {
        success: true,
        message: 'Successfully rebased.',
      }

      mockInvoke
        .mockResolvedValueOnce(mockResult)
        .mockResolvedValueOnce({ branch: 'feature' } as GitRepositoryStatus)
        .mockResolvedValueOnce([])

      const store = createTestStore()
      const result = await store.getState().rebaseContinue('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_rebase_continue', {
        workspacePath: '/workspace',
      })
      expect(result).toEqual(mockResult)
    })
  })

  describe('状态同步', () => {
    it('创建分支后应刷新状态和分支列表', async () => {
      const mockStatus: GitRepositoryStatus = {
        branch: 'new-branch',
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
      const mockBranches: GitBranch[] = [createMockBranch('new-branch', true)]

      mockInvoke
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(mockStatus)
        .mockResolvedValueOnce(mockBranches)

      const store = createTestStore()
      await store.getState().createBranch('/workspace', 'new-branch', true)

      // 验证调用顺序
      expect(mockInvoke).toHaveBeenNthCalledWith(1, 'git_create_branch', expect.any(Object))
      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'git_get_status', expect.any(Object))
      expect(mockInvoke).toHaveBeenNthCalledWith(3, 'git_get_branches', expect.any(Object))

      expect(store.getState().status?.branch).toBe('new-branch')
      expect(store.getState().branches).toHaveLength(1)
    })
  })
})
