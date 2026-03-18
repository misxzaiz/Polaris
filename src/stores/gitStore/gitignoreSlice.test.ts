/**
 * gitignoreSlice 单元测试
 *
 * 测试 Git .gitignore 操作功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock Tauri invoke
const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createGitignoreSlice } from './gitignoreSlice'
import { createStatusSlice } from './statusSlice'
import type { GitState, StatusState, StatusActions } from './types'
import type { GitIgnoreResult, GitIgnoreTemplate, GitRepositoryStatus } from '@/types/git'

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
    ...createGitignoreSlice(...args),
  }))
}

describe('gitignoreSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getGitignore', () => {
    it('应成功获取 .gitignore 内容', async () => {
      const mockResult: GitIgnoreResult = {
        exists: true,
        content: 'node_modules/\n.env\n*.log',
      }
      mockInvoke.mockResolvedValueOnce(mockResult)

      const store = createTestStore()
      const result = await store.getState().getGitignore('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_get_gitignore', {
        workspacePath: '/workspace',
      })
      expect(result.exists).toBe(true)
      expect(result.content).toContain('node_modules/')
    })

    it('无 .gitignore 时应返回 exists: false', async () => {
      const mockResult: GitIgnoreResult = {
        exists: false,
        content: '',
      }
      mockInvoke.mockResolvedValueOnce(mockResult)

      const store = createTestStore()
      const result = await store.getState().getGitignore('/workspace')

      expect(result.exists).toBe(false)
      expect(result.content).toBe('')
    })

    it('应正确处理获取错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Permission denied'))

      const store = createTestStore()
      await expect(
        store.getState().getGitignore('/workspace')
      ).rejects.toThrow('Permission denied')
    })
  })

  describe('saveGitignore', () => {
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

    it('应成功保存 .gitignore 内容', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // git_save_gitignore
        .mockResolvedValueOnce(mockStatus) // refreshStatus

      const store = createTestStore()
      await store.getState().saveGitignore('/workspace', 'node_modules/\n.env\n*.log')

      expect(mockInvoke).toHaveBeenCalledWith('git_save_gitignore', {
        workspacePath: '/workspace',
        content: 'node_modules/\n.env\n*.log',
      })
      expect(store.getState().isLoading).toBe(false)
    })

    it('保存后应刷新状态', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().saveGitignore('/workspace', 'test/')

      expect(mockInvoke).toHaveBeenNthCalledWith(1, 'git_save_gitignore', expect.any(Object))
      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'git_get_status', expect.any(Object))
    })

    it('应正确处理保存错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Cannot write file'))

      const store = createTestStore()
      await expect(
        store.getState().saveGitignore('/workspace', 'test/')
      ).rejects.toThrow('Cannot write file')

      expect(store.getState().error).toBe('Cannot write file')
    })
  })

  describe('addToGitignore', () => {
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

    it('应成功添加忽略规则', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // git_add_to_gitignore
        .mockResolvedValueOnce(mockStatus) // refreshStatus

      const store = createTestStore()
      await store.getState().addToGitignore('/workspace', ['*.log', '.env'])

      expect(mockInvoke).toHaveBeenCalledWith('git_add_to_gitignore', {
        workspacePath: '/workspace',
        rules: ['*.log', '.env'],
      })
      expect(store.getState().isLoading).toBe(false)
    })

    it('应支持添加单个规则', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().addToGitignore('/workspace', ['dist/'])

      expect(mockInvoke).toHaveBeenCalledWith('git_add_to_gitignore', {
        workspacePath: '/workspace',
        rules: ['dist/'],
      })
    })

    it('添加后应刷新状态', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().addToGitignore('/workspace', ['test/'])

      expect(mockInvoke).toHaveBeenNthCalledWith(1, 'git_add_to_gitignore', expect.any(Object))
      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'git_get_status', expect.any(Object))
    })

    it('应正确处理添加规则错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('.gitignore not found'))

      const store = createTestStore()
      await expect(
        store.getState().addToGitignore('/workspace', ['*.log'])
      ).rejects.toThrow('.gitignore not found')

      expect(store.getState().error).toBe('.gitignore not found')
    })
  })

  describe('getGitignoreTemplates', () => {
    it('应成功获取模板列表', async () => {
      const mockTemplates: GitIgnoreTemplate[] = [
        { name: 'Node', content: 'node_modules/\n' },
        { name: 'Python', content: '__pycache__/\n*.pyc\n' },
        { name: 'Java', content: '*.class\n*.jar\n' },
      ]
      mockInvoke.mockResolvedValueOnce(mockTemplates)

      const store = createTestStore()
      const result = await store.getState().getGitignoreTemplates()

      expect(mockInvoke).toHaveBeenCalledWith('git_get_gitignore_templates')
      expect(result).toHaveLength(3)
      expect(result[0].name).toBe('Node')
    })

    it('无模板时应返回空数组', async () => {
      mockInvoke.mockResolvedValueOnce([])

      const store = createTestStore()
      const result = await store.getState().getGitignoreTemplates()

      expect(result).toEqual([])
    })

    it('错误时应返回空数组并记录日志', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockInvoke.mockRejectedValueOnce(new Error('Network error'))

      const store = createTestStore()
      const result = await store.getState().getGitignoreTemplates()

      expect(result).toEqual([])
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })
})
