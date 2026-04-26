/**
 * GitStore 集成测试
 *
 * 测试多个 slice 之间的交互和状态同步
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
import { createBranchSlice } from './branchSlice'
import { createRemoteSlice } from './remoteSlice'
import { createCommitSlice } from './commitSlice'
import type { GitState, StatusState, StatusActions, BranchState, BranchActions, RemoteState, RemoteActions, CommitState, CommitActions } from './types'
import type { GitRepositoryStatus, GitBranch } from '@/types/git'

// 创建完整的测试 store
type TestState = StatusState &
  StatusActions &
  BranchState &
  BranchActions &
  RemoteState &
  RemoteActions &
  CommitState &
  CommitActions &
  Pick<GitState, 'tags' | 'currentPR' | 'stashList'>

function createFullStore() {
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

    // 分支状态
    branches: [],

    // 远程状态
    remotes: [],

    // Commit 状态
    commits: [],

    // 其他 slice 需要的状态
    tags: [],
    currentPR: null,
    stashList: [],

    // 应用所有 slice
    ...createStatusSlice(...args),
    ...createBranchSlice(...args),
    ...createRemoteSlice(...args),
    ...createCommitSlice(...args),
  }))
}

describe('GitStore Integration', () => {
  let store: ReturnType<typeof createFullStore>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    store = createFullStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('状态同步', () => {
    it('创建分支后应同步更新状态和分支列表', async () => {
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
      const mockBranches: GitBranch[] = [
        { name: 'main', isCurrent: false, isRemote: false },
        { name: 'new-branch', isCurrent: true, isRemote: false },
      ]

      mockInvoke
        .mockResolvedValueOnce(undefined) // git_create_branch
        .mockResolvedValueOnce(mockStatus) // git_get_status
        .mockResolvedValueOnce(mockBranches) // git_get_branches

      await store.getState().createBranch('/workspace', 'new-branch', true)

      expect(store.getState().status?.branch).toBe('new-branch')
      expect(store.getState().branches).toHaveLength(2)
      expect(store.getState().branches.find(b => b.isCurrent)?.name).toBe('new-branch')
    })

    it('提交后应同步更新状态和 commit 列表', async () => {
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

      mockInvoke
        .mockResolvedValueOnce('abc123') // git_commit
        .mockResolvedValueOnce(mockStatus) // git_get_status

      const result = await store.getState().commitChanges('/workspace', 'Test commit', true)

      expect(result).toBe('abc123')
      expect(store.getState().status?.ahead).toBe(1)
    })
  })

  describe('clearAll 操作', () => {
    it('应清除所有 slice 的状态', () => {
      // 设置各种状态
      store.setState({
        status: {
          branch: 'main',
          ahead: 1,
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
        branches: [{ name: 'main', isCurrent: true, isRemote: false }],
        remotes: [{ name: 'origin', url: 'https://github.com/user/repo.git' }],
        commits: [{ sha: 'abc123', message: 'Commit', author: 'Test', date: '2024-01-01' }],
        error: 'Some error',
      })

      // 调用 clearAll
      store.getState().clearAll()

      // 验证所有状态被清除
      expect(store.getState().status).toBeNull()
      expect(store.getState().branches).toEqual([])
      expect(store.getState().remotes).toEqual([])
      expect(store.getState().commits).toEqual([])
      expect(store.getState().tags).toEqual([])
      expect(store.getState().error).toBeNull()
    })
  })

  describe('状态联动', () => {
    it('pull 操作应更新 status', async () => {
      const initialStatus: GitRepositoryStatus = {
        branch: 'main',
        ahead: 0,
        behind: 5,
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
      const afterPullStatus: GitRepositoryStatus = {
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

      store.setState({ status: initialStatus })

      mockInvoke
        .mockResolvedValueOnce({ success: true, message: 'Updated' }) // git_pull
        .mockResolvedValueOnce(afterPullStatus) // git_get_status

      await store.getState().pull('/workspace')

      expect(store.getState().status?.behind).toBe(0)
    })

    it('push 操作应正确处理成功', async () => {
      const initialStatus: GitRepositoryStatus = {
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

      const afterPushStatus: GitRepositoryStatus = {
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

      store.setState({ status: initialStatus })

      mockInvoke
        .mockResolvedValueOnce(undefined) // git_push_branch
        .mockResolvedValueOnce(afterPushStatus) // git_get_status

      const result = await store.getState().push('/workspace', 'main')

      expect(result.success).toBe(true)
      expect(result.pushedCommits).toBe(3)
    })
  })
})
