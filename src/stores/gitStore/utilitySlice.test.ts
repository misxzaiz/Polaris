/**
 * utilitySlice 单元测试
 *
 * 测试 Git 工具方法功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock Tauri invoke
const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createUtilitySlice } from './utilitySlice'
import { createStatusSlice } from './statusSlice'
import type { GitState, StatusState, StatusActions } from './types'
import type { GitBlameResult, GitRepositoryStatus } from '@/types/git'

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
    ...createUtilitySlice(...args),
  }))
}

describe('utilitySlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('isRepository', () => {
    it('应正确识别 Git 仓库', async () => {
      mockInvoke.mockResolvedValueOnce(true)

      const store = createTestStore()
      const result = await store.getState().isRepository('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_is_repository', {
        workspacePath: '/workspace',
      })
      expect(result).toBe(true)
    })

    it('应正确识别非 Git 目录', async () => {
      mockInvoke.mockResolvedValueOnce(false)

      const store = createTestStore()
      const result = await store.getState().isRepository('/non-git-folder')

      expect(result).toBe(false)
    })

    it('错误时应返回 false', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Permission denied'))

      const store = createTestStore()
      const result = await store.getState().isRepository('/protected')

      expect(result).toBe(false)
    })
  })

  describe('initRepository', () => {
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

    it('应成功初始化仓库', async () => {
      mockInvoke
        .mockResolvedValueOnce('abc123') // git_init_repository
        .mockResolvedValueOnce(mockStatus) // refreshStatus

      const store = createTestStore()
      const result = await store.getState().initRepository('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_init_repository', {
        workspacePath: '/workspace',
        initialBranch: 'main',
      })
      expect(result).toBe('abc123')
      expect(store.getState().isLoading).toBe(false)
    })

    it('应支持指定初始分支名', async () => {
      mockInvoke
        .mockResolvedValueOnce('def456')
        .mockResolvedValueOnce({ ...mockStatus, branch: 'develop' })

      const store = createTestStore()
      await store.getState().initRepository('/workspace', 'develop')

      expect(mockInvoke).toHaveBeenCalledWith('git_init_repository', {
        workspacePath: '/workspace',
        initialBranch: 'develop',
      })
    })

    it('初始化后应刷新状态', async () => {
      mockInvoke
        .mockResolvedValueOnce('abc123')
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().initRepository('/workspace')

      expect(mockInvoke).toHaveBeenNthCalledWith(1, 'git_init_repository', expect.any(Object))
      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'git_get_status', expect.any(Object))
    })

    it('应正确处理初始化错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Directory already a git repository'))

      const store = createTestStore()
      await expect(
        store.getState().initRepository('/workspace')
      ).rejects.toThrow('already a git repository')

      expect(store.getState().error).toContain('already a git repository')
    })
  })

  describe('blameFile', () => {
    it('应成功获取文件 Blame 信息', async () => {
      const mockBlame: GitBlameResult = {
        path: 'src/file.ts',
        lines: [
          {
            lineNumber: 1,
            content: 'import React from "react"',
            commitSha: 'abc123',
            author: 'John Doe',
            authorEmail: 'john@example.com',
            date: '2026-03-15T10:00:00Z',
          },
          {
            lineNumber: 2,
            content: '',
            commitSha: 'def456',
            author: 'Jane Doe',
            authorEmail: 'jane@example.com',
            date: '2026-03-16T11:00:00Z',
          },
        ],
      }
      mockInvoke.mockResolvedValueOnce(mockBlame)

      const store = createTestStore()
      const result = await store.getState().blameFile('/workspace', 'src/file.ts')

      expect(mockInvoke).toHaveBeenCalledWith('git_blame_file', {
        workspacePath: '/workspace',
        filePath: 'src/file.ts',
      })
      expect(result.lines).toHaveLength(2)
      expect(result.lines[0].author).toBe('John Doe')
      expect(store.getState().isLoading).toBe(false)
    })

    it('应正确处理 Blame 错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('File not found'))

      const store = createTestStore()
      await expect(
        store.getState().blameFile('/workspace', 'missing.ts')
      ).rejects.toThrow('File not found')

      expect(store.getState().error).toBe('File not found')
    })

    it('应处理二进制文件', async () => {
      const mockBlame: GitBlameResult = {
        path: 'image.png',
        lines: [],
      }
      mockInvoke.mockResolvedValueOnce(mockBlame)

      const store = createTestStore()
      const result = await store.getState().blameFile('/workspace', 'image.png')

      expect(result.lines).toHaveLength(0)
    })

    it('应处理空文件', async () => {
      const mockBlame: GitBlameResult = {
        path: 'empty.txt',
        lines: [],
      }
      mockInvoke.mockResolvedValueOnce(mockBlame)

      const store = createTestStore()
      const result = await store.getState().blameFile('/workspace', 'empty.txt')

      expect(result.lines).toHaveLength(0)
    })
  })

  describe('错误处理', () => {
    it('错误应设置 error 状态', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Test error'))

      const store = createTestStore()
      try {
        await store.getState().blameFile('/workspace', 'file.ts')
      } catch {
        // 预期会抛出错误
      }

      expect(store.getState().error).toBe('Test error')
    })

    it('错误后 isLoading 应为 false', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Test error'))

      const store = createTestStore()
      try {
        await store.getState().blameFile('/workspace', 'file.ts')
      } catch {
        // 预期会抛出错误
      }

      expect(store.getState().isLoading).toBe(false)
    })
  })
})
