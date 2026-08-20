/**
 * prSlice 单元测试
 *
 * 测试 Git Pull Request 操作功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock Tauri invoke
const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createPRSlice } from './prSlice'
import type { GitState, PRState, PRActions, StatusState } from './types'
import type { PullRequest, CreatePROptions } from '@/types/git'

// 创建测试用的最小状态
type TestState = PRState &
  PRActions &
  StatusState &
  Pick<GitState, 'branches' | 'remotes' | 'tags' | 'commits' | 'stashList'>

// 创建测试用的 store
function createTestStore() {
  return create<TestState>((...args) => ({
    // PR 状态
    currentPR: null,

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
    commits: [],
    stashList: [],

    // 应用 slice
    ...createPRSlice(...args),
  }))
}

// 创建模拟的 PR 数据
function createMockPR(number: number, title: string): PullRequest {
  return {
    id: number,
    number,
    title,
    body: `PR body for ${title}`,
    state: 'open',
    head: {
      ref: 'feature-branch',
      sha: 'abc123',
    },
    base: {
      ref: 'main',
      sha: 'def456',
    },
    author: 'testuser',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    url: `https://github.com/user/repo/pull/${number}`,
  }
}

describe('prSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('应正确初始化 currentPR 为 null', () => {
      const store = createTestStore()
      expect(store.getState().currentPR).toBeNull()
    })
  })

  describe('createPR', () => {
    it('应成功创建 PR', async () => {
      const mockPR = createMockPR(42, 'Add new feature')
      const options: CreatePROptions = {
        title: 'Add new feature',
        body: 'This PR adds a new feature',
        head: 'feature-branch',
        base: 'main',
      }

      mockInvoke.mockResolvedValueOnce(mockPR)

      const store = createTestStore()
      const result = await store.getState().createPR('/workspace', options)

      expect(mockInvoke).toHaveBeenCalledWith('git_create_pr', {
        workspacePath: '/workspace',
        options,
      })
      expect(result).toEqual(mockPR)
      expect(store.getState().currentPR).toEqual(mockPR)
      expect(store.getState().isLoading).toBe(false)
    })

    it('应正确处理创建 PR 错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Branch already has a PR'))

      const store = createTestStore()
      const options: CreatePROptions = {
        title: 'Add new feature',
        body: '',
        head: 'feature-branch',
        base: 'main',
      }

      await expect(
        store.getState().createPR('/workspace', options)
      ).rejects.toThrow('Branch already has a PR')

      expect(store.getState().error).toBe('Branch already has a PR')
      expect(store.getState().currentPR).toBeNull()
      expect(store.getState().isLoading).toBe(false)
    })

    it('应支持创建带草稿标签的 PR', async () => {
      const mockPR = { ...createMockPR(43, 'WIP: Feature'), draft: true }
      const options: CreatePROptions = {
        title: 'WIP: Feature',
        body: 'Work in progress',
        head: 'feature-branch',
        base: 'main',
        draft: true,
      }

      mockInvoke.mockResolvedValueOnce(mockPR)

      const store = createTestStore()
      const result = await store.getState().createPR('/workspace', options)

      expect(result.draft).toBe(true)
    })
  })

  describe('getPRStatus', () => {
    it('应成功获取 PR 状态', async () => {
      const mockPR = createMockPR(42, 'Add new feature')

      mockInvoke.mockResolvedValueOnce(mockPR)

      const store = createTestStore()
      const result = await store.getState().getPRStatus('/workspace', 42)

      expect(mockInvoke).toHaveBeenCalledWith('git_get_pr_status', {
        workspacePath: '/workspace',
        prNumber: 42,
      })
      expect(result).toEqual(mockPR)
      expect(store.getState().currentPR).toEqual(mockPR)
      expect(store.getState().isLoading).toBe(false)
    })

    it('应正确处理获取 PR 状态错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('PR not found'))

      const store = createTestStore()
      await expect(
        store.getState().getPRStatus('/workspace', 999)
      ).rejects.toThrow('PR not found')

      expect(store.getState().error).toBe('PR not found')
    })

    it('应支持获取已合并的 PR', async () => {
      const mockPR = {
        ...createMockPR(42, 'Merged feature'),
        state: 'merged',
        mergedAt: new Date().toISOString(),
      }

      mockInvoke.mockResolvedValueOnce(mockPR)

      const store = createTestStore()
      const result = await store.getState().getPRStatus('/workspace', 42)

      expect(result.state).toBe('merged')
    })

    it('应支持获取已关闭的 PR', async () => {
      const mockPR = {
        ...createMockPR(42, 'Closed feature'),
        state: 'closed',
        closedAt: new Date().toISOString(),
      }

      mockInvoke.mockResolvedValueOnce(mockPR)

      const store = createTestStore()
      const result = await store.getState().getPRStatus('/workspace', 42)

      expect(result.state).toBe('closed')
    })
  })

  describe('状态管理', () => {
    it('创建 PR 后应更新 currentPR', async () => {
      const mockPR = createMockPR(42, 'Test PR')
      mockInvoke.mockResolvedValueOnce(mockPR)

      const store = createTestStore()
      expect(store.getState().currentPR).toBeNull()

      await store.getState().createPR('/workspace', {
        title: 'Test PR',
        body: '',
        head: 'feature',
        base: 'main',
      })

      expect(store.getState().currentPR).toEqual(mockPR)
    })

    it('获取 PR 状态后应更新 currentPR', async () => {
      const mockPR = createMockPR(42, 'Existing PR')
      mockInvoke.mockResolvedValueOnce(mockPR)

      const store = createTestStore()
      await store.getState().getPRStatus('/workspace', 42)

      expect(store.getState().currentPR).toEqual(mockPR)
    })

    it('创建 PR 失败时应清空 currentPR', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('API error'))

      const store = createTestStore()
      // 先设置一个 currentPR
      store.setState({ currentPR: createMockPR(1, 'Old PR') })

      try {
        await store.getState().createPR('/workspace', {
          title: 'New PR',
          body: '',
          head: 'feature',
          base: 'main',
        })
      } catch {
        // 预期会抛出错误
      }

      expect(store.getState().currentPR).toBeNull()
    })
  })
})
