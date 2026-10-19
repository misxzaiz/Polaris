/**
 * P1.5 分片验收测试：读型数据域按 wsPath 键控
 *
 * 场景：sidebar 与 workbench 双面板并发刷新不同工作区（A5 互踩防线）——
 * 后完成的请求不得覆盖先完成工作区的 keyed 数据（乱序返回安全）。
 * 旧镜像域（branches/diffs 等）按既有先例保持落后语义；新 UI 只读 keyed 域。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'

// Mock 统一 transport（slice 经 @/services/transport 调用后端）
const mockInvoke = vi.fn()
vi.mock('@/services/transport', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createBranchSlice } from './branchSlice'
import { createTagSlice } from './tagSlice'
import { createRemoteSlice } from './remoteSlice'
import { createCommitSlice } from './commitSlice'
import { createStashSlice } from './stashSlice'
import { createStatusSlice } from './statusSlice'
import type {
  StatusState,
  StatusActions,
  BranchState,
  BranchActions,
  TagState,
  TagActions,
  RemoteState,
  RemoteActions,
  CommitState,
  CommitActions,
  StashState,
  StashActions,
  UtilityState,
  UtilityActions,
  GitignoreState,
  GitignoreActions,
} from './types'

type TestState = StatusState &
  StatusActions &
  BranchState &
  BranchActions &
  TagState &
  TagActions &
  RemoteState &
  RemoteActions &
  CommitState &
  CommitActions &
  StashState &
  StashActions &
  UtilityState &
  UtilityActions &
  GitignoreState &
  GitignoreActions

function createTestStore() {
  return create<TestState>((...args) => ({
    // statusSlice 初始
    status: null,
    statuses: {},
    _statusSeq: {},
    diffs: [],
    worktreeDiffs: [],
    indexDiffs: [],
    diffsByWs: {},
    worktreeDiffsByWs: {},
    indexDiffsByWs: {},
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

    // 其余 slice 初始
    branches: [],
    branchesByWs: {},
    tags: [],
    tagsByWs: {},
    remotes: [],
    remotesByWs: {},
    commits: [],
    commitsByWs: {},
    commitDetails: {},
    stashList: [],
    stashListByWs: {},

    // 应用 slice
    ...createStatusSlice(...args),
    ...createBranchSlice(...args),
    ...createTagSlice(...args),
    ...createRemoteSlice(...args),
    ...createCommitSlice(...args),
    ...createStashSlice(...args),
  }))
}

/** 按 workspacePath 生成可区分的值 */
const dataFor = (ws: string, n: number) => [
  { name: `${ws}-branch-${n}` },
  { name: `${ws}-branch-${n}-b` },
]

const W1 = 'D:/ws/one'
const W2 = 'D:/ws/two'

beforeEach(() => {
  mockInvoke.mockReset()
})

describe('P1.5 数据域按 wsPath 分片（双面板并发）', () => {
  it('getBranches 乱序完成时 keyed 域互不覆盖', async () => {
    const useStore = createTestStore()

    // W1 慢、W2 快：受控 promise 制造交错
    let resolveW1!: (v: unknown) => void
    mockInvoke.mockImplementation((cmd: string, args: { workspacePath: string }) => {
      if (cmd !== 'git_get_branches') return Promise.resolve([] as unknown)
      if (args.workspacePath === W1) {
        return new Promise((res) => { resolveW1 = () => res(dataFor(W1, 1) as unknown as never) })
      }
      return Promise.resolve(dataFor(W2, 2) as unknown as never)
    })

    const p1 = useStore.getState().getBranches(W1)
    await useStore.getState().getBranches(W2)

    // W2 已入 keyed 域；W1 未完成前不得写 W1 slot
    expect(useStore.getState().branchesByWs?.[W2]).toEqual(dataFor(W2, 2))
    expect(useStore.getState().branchesByWs?.[W1]).toBeUndefined()

    resolveW1!()
    await p1

    // W1 晚到只写自己的 slot，不踩 W2
    expect(useStore.getState().branchesByWs?.[W1]).toEqual(dataFor(W1, 1))
    expect(useStore.getState().branchesByWs?.[W2]).toEqual(dataFor(W2, 2))
  })

  it('getWorktreeDiff 按 wsPath 分片且失败时写空数组到本 slot', async () => {
    const useStore = createTestStore()

    mockInvoke.mockImplementation((cmd: string, args: { workspacePath: string }) => {
      if (cmd === 'git_get_worktree_diff') {
        if (args.workspacePath === W1) return Promise.reject(new Error('not a repo'))
        return Promise.resolve([{ path: `${W2}/file`, status: 'M' }] as unknown as never)
      }
      return Promise.resolve([] as unknown)
    })

    await useStore.getState().getWorktreeDiff(W2)
    await useStore.getState().getWorktreeDiff(W1)

    expect(useStore.getState().worktreeDiffsByWs?.[W2]).toEqual([
      { path: `${W2}/file`, status: 'M' },
    ])
    expect(useStore.getState().worktreeDiffsByWs?.[W1]).toEqual([])
    // W2 数据未被 W1 失败冲掉
    expect(useStore.getState().worktreeDiffsByWs?.[W2]).not.toEqual([])
  })

  it('getTags/getRemotes/getStashList/getLog 均写入各自 keyed 域', async () => {
    const useStore = createTestStore()

    mockInvoke.mockImplementation((cmd: string, args: { workspacePath: string }) => {
      const ws = args.workspacePath
      switch (cmd) {
        case 'git_get_tags':
          return Promise.resolve([{ name: `${ws}-v1` }] as unknown as never)
        case 'git_get_remotes':
          return Promise.resolve([{ name: `${ws}-origin` }] as unknown as never)
        case 'git_stash_list':
        case 'git_get_stash_list':
          return Promise.resolve([{ id: `${ws}-stash` }] as unknown as never)
        case 'git_get_log':
          return Promise.resolve([{ sha: `${ws}-sha` }] as unknown as never)
        default:
          return Promise.resolve([] as unknown)
      }
    })

    await Promise.all([
      useStore.getState().getTags(W1),
      useStore.getState().getTags(W2),
      useStore.getState().getRemotes(W1),
      useStore.getState().getRemotes(W2),
      useStore.getState().getStashList(W1),
      useStore.getState().getStashList(W2),
      useStore.getState().getLog(W1),
      useStore.getState().getLog(W2),
    ])

    const s = useStore.getState()
    expect(s.tagsByWs?.[W1]).toEqual([{ name: `${W1}-v1` }])
    expect(s.tagsByWs?.[W2]).toEqual([{ name: `${W2}-v1` }])
    expect(s.remotesByWs?.[W1]).toEqual([{ name: `${W1}-origin` }])
    expect(s.remotesByWs?.[W2]).toEqual([{ name: `${W2}-origin` }])
    expect(s.stashListByWs?.[W1]).toEqual([{ id: `${W1}-stash` }])
    expect(s.stashListByWs?.[W2]).toEqual([{ id: `${W2}-stash` }])
    expect(s.commitsByWs?.[W1]).toEqual([{ sha: `${W1}-sha` }])
    expect(s.commitsByWs?.[W2]).toEqual([{ sha: `${W2}-sha` }])
  })
})
