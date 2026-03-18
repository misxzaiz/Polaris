/**
 * commitSlice 单元测试
 *
 * 测试 Git 提交和暂存操作功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock Tauri invoke
const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createCommitSlice } from './commitSlice'
import { createStatusSlice } from './statusSlice'
import type { GitState, CommitState, CommitActions, StatusState, StatusActions } from './types'
import type { GitCommit, GitRepositoryStatus, BatchStageResult } from '@/types/git'

// 创建测试用的最小状态
type TestState = CommitState &
  CommitActions &
  StatusState &
  StatusActions &
  Pick<GitState, 'branches' | 'remotes' | 'tags' | 'currentPR' | 'stashList'>

// 创建测试用的 store
function createTestStore() {
  return create<TestState>((...args) => ({
    // Commit 状态
    commits: [],

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
    currentPR: [],
    stashList: [],

    // 应用 slice
    ...createStatusSlice(...args),
    ...createCommitSlice(...args),
  }))
}

// 创建模拟的提交数据
function createMockCommit(sha: string, message: string): GitCommit {
  return {
    sha,
    message,
    author: 'Test Author',
    email: 'test@example.com',
    date: new Date().toISOString(),
  }
}

describe('commitSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('应正确初始化提交列表为空数组', () => {
      const store = createTestStore()
      expect(store.getState().commits).toEqual([])
    })
  })

  describe('commitChanges', () => {
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

    it('应成功提交所有暂存的变更', async () => {
      mockInvoke
        .mockResolvedValueOnce('abc123') // git_commit_changes
        .mockResolvedValueOnce(mockStatus) // refreshStatus

      const store = createTestStore()
      const result = await store.getState().commitChanges('/workspace', 'Initial commit')

      expect(mockInvoke).toHaveBeenCalledWith('git_commit_changes', {
        workspacePath: '/workspace',
        message: 'Initial commit',
        stageAll: true,
        selectedFiles: null,
      })
      expect(result).toBe('abc123')
      expect(store.getState().isLoading).toBe(false)
    })

    it('应支持仅提交选中的文件', async () => {
      mockInvoke
        .mockResolvedValueOnce('def456')
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().commitChanges(
        '/workspace',
        'Update specific files',
        false,
        ['src/file1.ts', 'src/file2.ts']
      )

      expect(mockInvoke).toHaveBeenCalledWith('git_commit_changes', {
        workspacePath: '/workspace',
        message: 'Update specific files',
        stageAll: false,
        selectedFiles: ['src/file1.ts', 'src/file2.ts'],
      })
    })

    it('提交后应清理选中状态', async () => {
      mockInvoke
        .mockResolvedValueOnce('abc123')
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      store.setState({
        selectedFilePath: 'file.ts',
        selectedDiff: { path: 'file.ts', status: 'modified', hunks: [] },
      })

      await store.getState().commitChanges('/workspace', 'Test commit')

      expect(store.getState().selectedFilePath).toBeNull()
      expect(store.getState().selectedDiff).toBeNull()
    })

    it('应正确处理提交错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Nothing to commit'))

      const store = createTestStore()
      await expect(
        store.getState().commitChanges('/workspace', 'Empty commit')
      ).rejects.toThrow('Nothing to commit')

      expect(store.getState().error).toBe('Nothing to commit')
    })
  })

  describe('stageFile', () => {
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

    it('应成功暂存文件', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // git_stage_file
        .mockResolvedValueOnce(mockStatus) // refreshStatus

      const store = createTestStore()
      await store.getState().stageFile('/workspace', 'src/file.ts')

      expect(mockInvoke).toHaveBeenCalledWith('git_stage_file', {
        workspacePath: '/workspace',
        filePath: 'src/file.ts',
      })
      expect(store.getState().isLoading).toBe(false)
    })

    it('应正确处理暂存错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('File not found'))

      const store = createTestStore()
      await expect(
        store.getState().stageFile('/workspace', 'missing.ts')
      ).rejects.toThrow('File not found')

      expect(store.getState().error).toBe('File not found')
    })
  })

  describe('unstageFile', () => {
    const mockStatus: GitRepositoryStatus = {
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
    }

    it('应成功取消暂存文件', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().unstageFile('/workspace', 'src/file.ts')

      expect(mockInvoke).toHaveBeenCalledWith('git_unstage_file', {
        workspacePath: '/workspace',
        filePath: 'src/file.ts',
      })
    })
  })

  describe('discardChanges', () => {
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

    it('应成功丢弃变更', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().discardChanges('/workspace', 'src/file.ts')

      expect(mockInvoke).toHaveBeenCalledWith('git_discard_changes', {
        workspacePath: '/workspace',
        filePath: 'src/file.ts',
      })
    })

    it('应正确处理丢弃变更错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('File has merge conflicts'))

      const store = createTestStore()
      await expect(
        store.getState().discardChanges('/workspace', 'conflicted.ts')
      ).rejects.toThrow('File has merge conflicts')
    })
  })

  describe('batchStage', () => {
    const mockStatus: GitRepositoryStatus = {
      branch: 'main',
      ahead: 0,
      behind: 0,
      staged: [
        { path: 'file1.ts', status: 'modified' },
        { path: 'file2.ts', status: 'added' },
      ],
      unstaged: [],
      untracked: [],
      conflicts: [],
      stashes: 0,
      isRebasing: false,
      isMerging: false,
      isCherryPicking: false,
      isReverting: false,
    }

    it('应成功批量暂存文件', async () => {
      const mockResult: BatchStageResult = {
        success: true,
        stagedCount: 2,
        failedCount: 0,
        errors: [],
      }
      mockInvoke
        .mockResolvedValueOnce(mockResult)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      const result = await store.getState().batchStage('/workspace', ['file1.ts', 'file2.ts'])

      expect(mockInvoke).toHaveBeenCalledWith('git_batch_stage', {
        workspacePath: '/workspace',
        filePaths: ['file1.ts', 'file2.ts'],
      })
      expect(result.stagedCount).toBe(2)
    })

    it('应处理部分失败的情况', async () => {
      const mockResult: BatchStageResult = {
        success: false,
        stagedCount: 1,
        failedCount: 1,
        errors: [{ file: 'missing.ts', error: 'File not found' }],
      }
      mockInvoke
        .mockResolvedValueOnce(mockResult)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      const result = await store.getState().batchStage('/workspace', ['file1.ts', 'missing.ts'])

      expect(result.failedCount).toBe(1)
      expect(result.errors).toHaveLength(1)
    })
  })

  describe('getLog', () => {
    it('应成功获取提交历史', async () => {
      const mockCommits: GitCommit[] = [
        createMockCommit('abc123', 'Third commit'),
        createMockCommit('def456', 'Second commit'),
        createMockCommit('ghi789', 'Initial commit'),
      ]
      mockInvoke.mockResolvedValueOnce(mockCommits)

      const store = createTestStore()
      const result = await store.getState().getLog('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_get_log', {
        workspacePath: '/workspace',
        limit: 50,
        skip: 0,
        branch: null,
      })
      expect(result).toEqual(mockCommits)
      expect(store.getState().commits).toEqual(mockCommits)
    })

    it('应支持分页参数', async () => {
      const mockCommits: GitCommit[] = [
        createMockCommit('jkl012', 'Fourth commit'),
      ]
      mockInvoke.mockResolvedValueOnce(mockCommits)

      const store = createTestStore()
      await store.getState().getLog('/workspace', 10, 30)

      expect(mockInvoke).toHaveBeenCalledWith('git_get_log', {
        workspacePath: '/workspace',
        limit: 10,
        skip: 30,
        branch: null,
      })
    })

    it('应支持按分支筛选', async () => {
      const mockCommits: GitCommit[] = [
        createMockCommit('abc123', 'Feature commit'),
      ]
      mockInvoke.mockResolvedValueOnce(mockCommits)

      const store = createTestStore()
      await store.getState().getLog('/workspace', 50, 0, 'feature')

      expect(mockInvoke).toHaveBeenCalledWith('git_get_log', {
        workspacePath: '/workspace',
        limit: 50,
        skip: 0,
        branch: 'feature',
      })
    })

    it('应正确处理获取历史错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Invalid branch name'))

      const store = createTestStore()
      const result = await store.getState().getLog('/workspace', 50, 0, 'nonexistent')

      expect(result).toEqual([])
      expect(store.getState().error).toBe('Invalid branch name')
    })
  })
})
