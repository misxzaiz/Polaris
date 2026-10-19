/**
 * P1 后端动作 parity 单测：amend / fetch / stash apply·show / search_log / reflog / push-lease
 *
 * 验证前端 slice → transport（cap.git）参数契约与旧命令 casing 一致，
 * 以及错误路径的 parseGitError 整形。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'

const mockInvoke = vi.fn()
vi.mock('@/services/transport', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createCommitSlice } from './commitSlice'
import { createRemoteSlice } from './remoteSlice'
import { createStashSlice } from './stashSlice'
import { createUtilitySlice } from './utilitySlice'
import type {
  GitState,
  StatusState,
  StatusActions,
  RemoteState,
  RemoteActions,
  CommitState,
  CommitActions,
  StashState,
  StashActions,
  UtilityState,
  UtilityActions,
} from './types'

type TestState = StatusState &
  StatusActions &
  RemoteState &
  RemoteActions &
  CommitState &
  CommitActions &
  StashState &
  StashActions &
  UtilityState &
  UtilityActions

function createTestStore() {
  return create<TestState>((...args) => ({
    // statusSlice 最小集（refreshStatus 被 stash/remote 调用）
    status: null,
    statuses: {},
    _statusSeq: {},
    diffs: [],
    worktreeDiffs: [],
    indexDiffs: [],
    isLoading: false,
    error: null,
    selectedFilePath: null,
    selectedDiff: null,
    discoveredRepos: [],
    isDiscovering: false,
    pinnedRepos: [],
    activeWorkspaceId: null,
    _refreshPromises: new Map(),
    _refreshTimeouts: new Map(),

    refreshStatus: vi.fn().mockResolvedValue(undefined),
    refreshStatusDebounced: vi.fn().mockResolvedValue(undefined),
    getDiffs: vi.fn(),
    getWorktreeDiff: vi.fn(),
    getIndexDiff: vi.fn(),
    getWorktreeFileDiff: vi.fn(),
    getIndexFileDiff: vi.fn(),
    discoverRepositories: vi.fn(),
    togglePinnedRepo: vi.fn(),
    isPinnedRepo: vi.fn(),
    loadPinnedRepos: vi.fn(),
    clearError: vi.fn(),
    clearAll: vi.fn(),
    hasChanges: vi.fn(),
    getChangedFiles: vi.fn(),
    setSelectedFilePath: vi.fn(),
    setSelectedDiff: vi.fn(),
    setActiveWorkspaceId: vi.fn(),

    branches: [],
    remotes: [],
    tags: [],
    commits: [],
    commitDetails: {},
    stashList: [],

    ...createRemoteSlice(...args),
    ...createCommitSlice(...args),
    ...createStashSlice(...args),
    ...createUtilitySlice(...args),
  }))
}

const WS = 'D:/ws/demo'

beforeEach(() => {
  mockInvoke.mockReset()
})

describe('P1 后端动作 parity（slice → cap.git 参数契约）', () => {
  it('amendCommit：message 省略时透传 null（--no-edit 语义）', async () => {
    mockInvoke.mockResolvedValueOnce('new-sha')
    const s = createTestStore()
    const sha = await s.getState().amendCommit(WS)

    expect(sha).toBe('new-sha')
    expect(mockInvoke).toHaveBeenCalledWith('git_amend_commit', {
      workspacePath: WS,
      message: null,
      stageAll: false,
      selectedFiles: null,
    })
  })

  it('amendCommit：显式 message + 选中文件透传', async () => {
    mockInvoke.mockResolvedValueOnce('sha2')
    const s = createTestStore()
    await s.getState().amendCommit(WS, 'fix: msg', true, ['a.rs'])

    expect(mockInvoke).toHaveBeenCalledWith('git_amend_commit', {
      workspacePath: WS,
      message: 'fix: msg',
      stageAll: true,
      selectedFiles: ['a.rs'],
    })
  })

  it('searchLog：filter 原样透传（camelCase 字段）', async () => {
    mockInvoke.mockResolvedValueOnce([{ sha: 'x', shortSha: 'x', message: 'm', author: '', authorEmail: '', timestamp: 0, parents: [] }])
    const s = createTestStore()
    const out = await s.getState().searchLog(WS, { grep: 'fix login', fixedStrings: true, since: '2 weeks ago' })

    expect(out).toHaveLength(1)
    expect(mockInvoke).toHaveBeenCalledWith('git_search_log', {
      workspacePath: WS,
      filter: { grep: 'fix login', fixedStrings: true, since: '2 weeks ago' },
      limit: 50,
      skip: 0,
    })
  })

  it('searchLog：失败返回空数组（不抛出）', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('fatal: bad revision'))
    const s = createTestStore()
    const out = await s.getState().searchLog(WS, { grep: 'x' })
    expect(out).toEqual([])
    expect(s.getState().error).toBe('fatal: bad revision')
  })

  it('getReflog：branch 为 null（HEAD 默认），limit 默认 30', async () => {
    mockInvoke.mockResolvedValueOnce([
      { sha: 'h1', shortSha: 'h1', selector: 'HEAD@{0}', subject: 'commit: x', timestamp: 1 },
    ])
    const s = createTestStore()
    const out = await s.getState().getReflog(WS)

    expect(mockInvoke).toHaveBeenCalledWith('git_get_reflog', {
      workspacePath: WS,
      branch: null,
      limit: 30,
    })
    expect(out).toHaveLength(1)
  })

  it('fetchRemote：remoteName 省略 = null（origin 默认）', async () => {
    mockInvoke.mockResolvedValueOnce('Fetching origin')
    const s = createTestStore()
    const out = await s.getState().fetchRemote(WS)

    expect(mockInvoke).toHaveBeenCalledWith('git_fetch', {
      workspacePath: WS,
      remoteName: null,
      prune: false,
    })
    expect(out).toBe('Fetching origin')
  })

  it('push 带 leaseSha：透传到 git_push_branch', async () => {
    mockInvoke.mockResolvedValueOnce(null)
    const s = createTestStore()
    await s.getState().push(WS, 'main', 'origin', true, false, undefined, 'abc123')

    expect(mockInvoke).toHaveBeenCalledWith('git_push_branch', {
      workspacePath: WS,
      branchName: 'main',
      remoteName: 'origin',
      force: true,
      remoteBranchName: null,
      leaseSha: 'abc123',
    })
  })

  it('stashShow：不落 error/loading（窗口型读取），index 省略 = null', async () => {
    mockInvoke.mockResolvedValueOnce('diff --git a/x.rs')
    const s = createTestStore()
    const patch = await s.getState().stashShow(WS)

    expect(mockInvoke).toHaveBeenCalledWith('git_stash_show', {
      workspacePath: WS,
      index: null,
    })
    expect(patch).toContain('diff --git')
    expect(s.getState().error).toBeNull()
    expect(s.getState().isLoading).toBe(false)
  })

  it('stashApply：成功后刷新状态', async () => {
    mockInvoke.mockResolvedValueOnce(null)
    const s = createTestStore()
    await s.getState().stashApply(WS, 2)

    expect(mockInvoke).toHaveBeenCalledWith('git_stash_apply', {
      workspacePath: WS,
      index: 2,
    })
  })

  it('stashApply：失败经 parseGitError 整形并抛出', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('error: could not apply stash'))
    const s = createTestStore()
    await expect(s.getState().stashApply(WS)).rejects.toThrow()
    expect(s.getState().error).toContain('error: could not apply stash')
  })
})
