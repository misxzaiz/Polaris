/**
 * undoSlice 单元测试
 *
 * 测试 Undo 网络（FR-P2-3）：快照列表 / 一键恢复 / 手动清理。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock 统一 transport（slice 经 @/services/transport 调用后端，非 @tauri-apps/api/core）
const mockInvoke = vi.fn()
vi.mock('@/services/transport', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createUndoSlice } from './undoSlice'
import type { GitState, UndoState, UndoActions, StatusState, StatusActions } from './types'
import type { UndoSnapshotMeta, UndoRestoreOutcome } from '@/types/git'

// 创建测试用的最小状态
type TestState = UndoState &
  UndoActions &
  StatusState &
  StatusActions &
  Pick<GitState, 'branches' | 'remotes' | 'tags' | 'currentPR' | 'commits'>

// 创建测试用的 store
function createTestStore() {
  return create<TestState>((...args) => ({
    // Undo 状态
    undoSnapshots: [],
    undoSnapshotsByWs: {},

    // 状态数据（refreshStatus 等下游依赖的共享域）
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

    // 应用 slice
    ...createUndoSlice(...args),

    // restore 成功后刷新的下游方法（mock：resolve 空）
    refreshStatus: async () => {},
    getBranches: async () => {},
    getLogWithLanes: async () => {},
  }))
}

// 创建模拟的 Undo 快照数据
function createMockSnapshot(ts: number, context: string, hasChanges: boolean): UndoSnapshotMeta {
  return {
    name: `refs/polaris-undo/C:_repo/${ts}`,
    createdAt: ts,
    context,
    hasChanges,
    branch: 'main',
  }
}

describe('undoSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('listUndoSnapshots', () => {
    it('拉取快照列表并按 wsPath 分片写入', async () => {
      const store = createTestStore()
      const snapshots = [createMockSnapshot(2, 'discard', true), createMockSnapshot(1, 'reset_hard', false)]
      mockInvoke.mockResolvedValueOnce(snapshots)

      const result = await store.getState().listUndoSnapshots('C:/repo')

      expect(mockInvoke).toHaveBeenCalledWith('git_undo_list', { workspacePath: 'C:/repo' })
      expect(result).toEqual(snapshots)
      expect(store.getState().undoSnapshots).toEqual(snapshots)
      expect(store.getState().undoSnapshotsByWs?.['C:/repo']).toEqual(snapshots)
    })

    it('拉取失败时返回空列表并记录 error', async () => {
      const store = createTestStore()
      mockInvoke.mockRejectedValueOnce(new Error('git: no repo'))

      const result = await store.getState().listUndoSnapshots('C:/repo')

      expect(result).toEqual([])
      expect(store.getState().error).toBe('git: no repo')
    })
  })

  describe('restoreUndoSnapshot', () => {
    it('调用恢复接口并刷新 status/branches/log', async () => {
      const store = createTestStore()
      const outcome: UndoRestoreOutcome = { ok: true, conflictedFiles: [], conflictMessage: null }
      mockInvoke.mockResolvedValueOnce(outcome)
      // refreshStatus / getBranches / getLogWithLanes 走同一 invoke mock，无对应分支时 resolve undefined
      mockInvoke.mockResolvedValue(undefined)

      const result = await store.getState().restoreUndoSnapshot('C:/repo', 'refs/polaris-undo/C:_repo/2')

      expect(mockInvoke).toHaveBeenCalledWith('git_undo_restore', {
        workspacePath: 'C:/repo',
        snapshotRef: 'refs/polaris-undo/C:_repo/2',
      })
      expect(result).toEqual(outcome)
      expect(store.getState().isLoading).toBe(false)
    })

    it('恢复失败时抛出并记录 error', async () => {
      const store = createTestStore()
      mockInvoke.mockRejectedValueOnce(new Error('git: apply failed'))

      await expect(store.getState().restoreUndoSnapshot('C:/repo', 'refs/x')).rejects.toThrow(
        'git: apply failed'
      )
      expect(store.getState().error).toBe('git: apply failed')
      expect(store.getState().isLoading).toBe(false)
    })
  })

  describe('dropUndoSnapshot', () => {
    it('调用删除接口并从本地缓存移除该项', async () => {
      const store = createTestStore()
      const snapshots = [createMockSnapshot(2, 'discard', true), createMockSnapshot(1, 'checkout', false)]
      mockInvoke.mockResolvedValueOnce(snapshots)
      await store.getState().listUndoSnapshots('C:/repo')

      mockInvoke.mockResolvedValueOnce(undefined)
      await store.getState().dropUndoSnapshot('C:/repo', snapshots[0].name)

      expect(mockInvoke).toHaveBeenCalledWith('git_undo_drop', {
        workspacePath: 'C:/repo',
        snapshotRef: snapshots[0].name,
      })
      expect(store.getState().undoSnapshots).toEqual([snapshots[1]])
      expect(store.getState().undoSnapshotsByWs?.['C:/repo']).toEqual([snapshots[1]])
    })
  })
})
