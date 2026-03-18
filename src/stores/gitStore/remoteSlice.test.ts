/**
 * remoteSlice 单元测试
 *
 * 测试 Git 远程仓库操作功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock Tauri invoke
const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createRemoteSlice } from './remoteSlice'
import { createStatusSlice } from './statusSlice'
import type { GitState, RemoteState, RemoteActions, StatusState, StatusActions } from './types'
import type { GitRemote, GitPullResult, GitPushResult, GitRepositoryStatus } from '@/types/git'

// 创建测试用的最小状态
type TestState = RemoteState &
  RemoteActions &
  StatusState &
  StatusActions &
  Pick<GitState, 'branches' | 'tags' | 'currentPR' | 'commits' | 'stashList'>

// 创建测试用的 store
function createTestStore() {
  return create<TestState>((...args) => ({
    // 远程状态
    remotes: [],

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
    tags: [],
    currentPR: null,
    commits: [],
    stashList: [],

    // 应用 slice
    ...createStatusSlice(...args),
    ...createRemoteSlice(...args),
  }))
}

// 创建模拟的远程数据
function createMockRemote(name: string, url: string): GitRemote {
  return { name, url }
}

describe('remoteSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('应正确初始化远程列表为空数组', () => {
      const store = createTestStore()
      expect(store.getState().remotes).toEqual([])
    })
  })

  describe('getRemotes', () => {
    it('应成功获取远程仓库列表', async () => {
      const mockRemotes: GitRemote[] = [
        createMockRemote('origin', 'https://github.com/user/repo.git'),
        createMockRemote('upstream', 'https://github.com/original/repo.git'),
      ]
      mockInvoke.mockResolvedValueOnce(mockRemotes)

      const store = createTestStore()
      await store.getState().getRemotes('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_get_remotes', {
        workspacePath: '/workspace',
      })
      expect(store.getState().remotes).toEqual(mockRemotes)
    })

    it('应正确处理获取远程列表错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Not a git repository'))

      const store = createTestStore()
      await store.getState().getRemotes('/workspace')

      expect(store.getState().remotes).toEqual([])
      expect(store.getState().error).toBe('Not a git repository')
    })
  })

  describe('addRemote', () => {
    it('应成功添加远程仓库', async () => {
      const newRemote = createMockRemote('fork', 'https://github.com/fork/repo.git')
      const mockRemotes: GitRemote[] = [
        createMockRemote('origin', 'https://github.com/user/repo.git'),
        newRemote,
      ]

      mockInvoke
        .mockResolvedValueOnce(newRemote) // git_add_remote
        .mockResolvedValueOnce(mockRemotes) // getRemotes

      const store = createTestStore()
      const result = await store.getState().addRemote('/workspace', 'fork', 'https://github.com/fork/repo.git')

      expect(mockInvoke).toHaveBeenCalledWith('git_add_remote', {
        workspacePath: '/workspace',
        name: 'fork',
        url: 'https://github.com/fork/repo.git',
      })
      expect(result).toEqual(newRemote)
      expect(store.getState().isLoading).toBe(false)
    })

    it('应正确处理添加远程仓库错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Remote already exists'))

      const store = createTestStore()
      await expect(
        store.getState().addRemote('/workspace', 'origin', 'https://example.com/repo.git')
      ).rejects.toThrow('Remote already exists')

      expect(store.getState().error).toBe('Remote already exists')
      expect(store.getState().isLoading).toBe(false)
    })
  })

  describe('removeRemote', () => {
    it('应成功删除远程仓库', async () => {
      const mockRemotes: GitRemote[] = [
        createMockRemote('origin', 'https://github.com/user/repo.git'),
      ]

      mockInvoke
        .mockResolvedValueOnce(undefined) // git_remove_remote
        .mockResolvedValueOnce(mockRemotes) // getRemotes

      const store = createTestStore()
      await store.getState().removeRemote('/workspace', 'upstream')

      expect(mockInvoke).toHaveBeenCalledWith('git_remove_remote', {
        workspacePath: '/workspace',
        name: 'upstream',
      })
      expect(store.getState().isLoading).toBe(false)
    })

    it('应正确处理删除远程仓库错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('No such remote'))

      const store = createTestStore()
      await expect(
        store.getState().removeRemote('/workspace', 'nonexistent')
      ).rejects.toThrow('No such remote')

      expect(store.getState().error).toBe('No such remote')
    })
  })

  describe('push', () => {
    const mockStatus: GitRepositoryStatus = {
      branch: 'main',
      ahead: 3,
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

    it('应成功推送分支', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // git_push_branch
        .mockResolvedValueOnce(mockStatus) // refreshStatus

      const store = createTestStore()
      // 预设 status 状态，以便 push 方法能获取到 ahead 数量
      store.setState({ status: mockStatus })
      const result = await store.getState().push('/workspace', 'main')

      expect(mockInvoke).toHaveBeenCalledWith('git_push_branch', {
        workspacePath: '/workspace',
        branchName: 'main',
        remoteName: 'origin',
        force: false,
      })
      expect(result.success).toBe(true)
      expect(result.pushedCommits).toBe(3)
    })

    it('应支持设置上游分支推送', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // git_push_set_upstream
        .mockResolvedValueOnce(mockStatus) // refreshStatus

      const store = createTestStore()
      await store.getState().push('/workspace', 'feature', 'origin', false, true)

      expect(mockInvoke).toHaveBeenCalledWith('git_push_set_upstream', {
        workspacePath: '/workspace',
        branchName: 'feature',
        remoteName: 'origin',
      })
    })

    it('应支持强制推送', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // git_push_branch
        .mockResolvedValueOnce(mockStatus) // refreshStatus

      const store = createTestStore()
      await store.getState().push('/workspace', 'main', 'origin', true, false)

      expect(mockInvoke).toHaveBeenCalledWith('git_push_branch', {
        workspacePath: '/workspace',
        branchName: 'main',
        remoteName: 'origin',
        force: true,
      })
    })

    it('应正确处理推送被拒绝', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('rejected: non-fast-forward'))

      const store = createTestStore()
      const result = await store.getState().push('/workspace', 'main')

      expect(result.success).toBe(false)
      expect(result.rejected).toBe(true)
      expect(result.error).toContain('rejected')
    })

    it('应正确处理需要设置上游分支', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('no upstream branch'))

      const store = createTestStore()
      const result = await store.getState().push('/workspace', 'new-branch')

      expect(result.success).toBe(false)
      expect(result.needsUpstream).toBe(true)
    })
  })

  describe('pull', () => {
    it('应成功拉取更新', async () => {
      const mockPullResult: GitPullResult = {
        success: true,
        message: 'Already up to date.',
      }
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

      mockInvoke
        .mockResolvedValueOnce(mockPullResult)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      const result = await store.getState().pull('/workspace')

      expect(mockInvoke).toHaveBeenCalledWith('git_pull', {
        workspacePath: '/workspace',
        remoteName: 'origin',
        branchName: null,
      })
      expect(result).toEqual(mockPullResult)
    })

    it('应支持指定远程和分支拉取', async () => {
      const mockPullResult: GitPullResult = {
        success: true,
        message: 'Fast-forwarded refs/heads/main to origin/main.',
      }
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

      mockInvoke
        .mockResolvedValueOnce(mockPullResult)
        .mockResolvedValueOnce(mockStatus)

      const store = createTestStore()
      await store.getState().pull('/workspace', 'upstream', 'main')

      expect(mockInvoke).toHaveBeenCalledWith('git_pull', {
        workspacePath: '/workspace',
        remoteName: 'upstream',
        branchName: 'main',
      })
    })

    it('应正确处理拉取错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Connection refused'))

      const store = createTestStore()
      await expect(
        store.getState().pull('/workspace')
      ).rejects.toThrow('Connection refused')

      expect(store.getState().error).toBe('Connection refused')
    })
  })

  describe('detectHostAsync', () => {
    it('应成功检测 Git Host', async () => {
      mockInvoke.mockResolvedValueOnce('github')

      const store = createTestStore()
      const result = await store.getState().detectHostAsync('https://github.com/user/repo.git')

      expect(mockInvoke).toHaveBeenCalledWith('git_detect_host', {
        remoteUrl: 'https://github.com/user/repo.git',
      })
      expect(result).toBe('github')
    })

    it('应支持检测多种 Git Host', async () => {
      const testCases = [
        { url: 'https://gitlab.com/user/repo.git', host: 'gitlab' },
        { url: 'https://bitbucket.org/user/repo.git', host: 'bitbucket' },
        { url: 'git@gitee.com:user/repo.git', host: 'gitee' },
      ]

      for (const { url, host } of testCases) {
        mockInvoke.mockResolvedValueOnce(host)
        const store = createTestStore()
        const result = await store.getState().detectHostAsync(url)
        expect(result).toBe(host)
      }
    })
  })
})
