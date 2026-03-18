/**
 * tagSlice 单元测试
 *
 * 测试 Git Tag 操作功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock Tauri invoke
const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createTagSlice } from './tagSlice'
import type { GitState, TagState, TagActions, StatusState, StatusActions } from './types'
import type { GitTag } from '@/types/git'

// 创建测试用的最小状态
type TestState = TagState &
  TagActions &
  StatusState &
  StatusActions &
  Pick<GitState, 'branches' | 'remotes' | 'currentPR' | 'commits' | 'stashList'>

// 创建测试用的 store
function createTestStore() {
  return create<TestState>((...args) => ({
    // Tag 状态
    tags: [],

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
    currentPR: null,
    commits: [],
    stashList: [],

    // 应用 slice（tagSlice 不需要其他 slice）
    ...createTagSlice(...args),
  }))
}

// 创建模拟的 Tag 数据
function createMockTag(name: string, sha: string): GitTag {
  return {
    name,
    sha,
    message: `Release ${name}`,
    tagger: 'Test Author',
    date: new Date().toISOString(),
  }
}

describe('tagSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('应正确初始化标签列表为空数组', () => {
      const store = createTestStore()
      expect(store.getState().tags).toEqual([])
    })
  })

  describe('getTags', () => {
    it('应成功获取标签列表', async () => {
      const mockTags: GitTag[] = [
        createMockTag('v1.0.0', 'abc123'),
        createMockTag('v1.1.0', 'def456'),
        createMockTag('v2.0.0', 'ghi789'),
      ]
      mockInvoke.mockResolvedValueOnce(mockTags)

      const store = createTestStore()
      const result = await store.getState().getTags('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_get_tags', {
        workspacePath: '/workspace',
      })
      expect(store.getState().tags).toEqual(mockTags)
      expect(result).toEqual(mockTags)
    })

    it('空仓库应返回空数组', async () => {
      mockInvoke.mockResolvedValueOnce([])

      const store = createTestStore()
      const result = await store.getState().getTags('/workspace')

      expect(result).toEqual([])
      expect(store.getState().tags).toEqual([])
    })

    it('应正确处理获取标签错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Not a git repository'))

      const store = createTestStore()
      const result = await store.getState().getTags('/workspace')

      expect(result).toEqual([])
      expect(store.getState().tags).toEqual([])
      expect(store.getState().error).toBe('Not a git repository')
    })
  })

  describe('createTag', () => {
    it('应成功创建轻量标签', async () => {
      const newTag = createMockTag('v2.1.0', 'jkl012')
      mockInvoke
        .mockResolvedValueOnce(newTag) // git_create_tag
        .mockResolvedValueOnce([newTag]) // getTags

      const store = createTestStore()
      const result = await store.getState().createTag('/workspace', 'v2.1.0')

      expect(mockInvoke).toHaveBeenCalledWith('git_create_tag', {
        workspacePath: '/workspace',
        name: 'v2.1.0',
        commitish: null,
        message: null,
      })
      expect(result).toEqual(newTag)
      expect(store.getState().isLoading).toBe(false)
    })

    it('应成功创建指定提交的标签', async () => {
      const newTag = createMockTag('v2.1.0', 'abc123')
      mockInvoke
        .mockResolvedValueOnce(newTag)
        .mockResolvedValueOnce([newTag])

      const store = createTestStore()
      await store.getState().createTag('/workspace', 'v2.1.0', 'abc123')

      expect(mockInvoke).toHaveBeenCalledWith('git_create_tag', {
        workspacePath: '/workspace',
        name: 'v2.1.0',
        commitish: 'abc123',
        message: null,
      })
    })

    it('应成功创建带注释的标签', async () => {
      const newTag = {
        ...createMockTag('v2.1.0', 'jkl012'),
        message: 'Release version 2.1.0',
      }
      mockInvoke
        .mockResolvedValueOnce(newTag)
        .mockResolvedValueOnce([newTag])

      const store = createTestStore()
      await store.getState().createTag(
        '/workspace',
        'v2.1.0',
        undefined,
        'Release version 2.1.0'
      )

      expect(mockInvoke).toHaveBeenCalledWith('git_create_tag', {
        workspacePath: '/workspace',
        name: 'v2.1.0',
        commitish: null,
        message: 'Release version 2.1.0',
      })
    })

    it('应正确处理创建标签错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Tag already exists'))

      const store = createTestStore()
      await expect(
        store.getState().createTag('/workspace', 'v1.0.0')
      ).rejects.toThrow('Tag already exists')

      expect(store.getState().error).toBe('Tag already exists')
      expect(store.getState().isLoading).toBe(false)
    })
  })

  describe('deleteTag', () => {
    it('应成功删除标签', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // git_delete_tag
        .mockResolvedValueOnce([]) // getTags

      const store = createTestStore()
      await store.getState().deleteTag('/workspace', 'v1.0.0')

      expect(mockInvoke).toHaveBeenCalledWith('git_delete_tag', {
        workspacePath: '/workspace',
        name: 'v1.0.0',
      })
      expect(store.getState().isLoading).toBe(false)
    })

    it('应正确处理删除标签错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Tag not found'))

      const store = createTestStore()
      await expect(
        store.getState().deleteTag('/workspace', 'nonexistent')
      ).rejects.toThrow('Tag not found')

      expect(store.getState().error).toBe('Tag not found')
    })
  })

  describe('状态同步', () => {
    it('创建标签后应刷新标签列表', async () => {
      const newTag = createMockTag('v2.1.0', 'jkl012')
      const allTags = [createMockTag('v1.0.0', 'abc123'), newTag]

      mockInvoke
        .mockResolvedValueOnce(newTag)
        .mockResolvedValueOnce(allTags)

      const store = createTestStore()
      await store.getState().createTag('/workspace', 'v2.1.0')

      // 验证调用顺序
      expect(mockInvoke).toHaveBeenNthCalledWith(1, 'git_create_tag', expect.any(Object))
      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'git_get_tags', expect.any(Object))

      expect(store.getState().tags).toHaveLength(2)
    })

    it('删除标签后应刷新标签列表', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([createMockTag('v2.0.0', 'ghi789')])

      const store = createTestStore()
      await store.getState().deleteTag('/workspace', 'v1.0.0')

      expect(mockInvoke).toHaveBeenNthCalledWith(1, 'git_delete_tag', expect.any(Object))
      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'git_get_tags', expect.any(Object))
    })
  })
})
