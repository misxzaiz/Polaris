/**
 * operationsSlice 单元测试
 *
 * 测试操作流水（FR-P2-4）：拉取 / 清空。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock 统一 transport（slice 经 @/services/transport 调用后端，非 @tauri-apps/api/core）
const mockInvoke = vi.fn()
vi.mock('@/services/transport', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createOperationsSlice } from './operationsSlice'
import type {
  GitState,
  OperationsState,
  OperationsActions,
  StatusState,
  StatusActions,
} from './types'
import type { GitOperationEntry } from '@/types/git'

// 创建测试用的最小状态
type TestState = OperationsState &
  OperationsActions &
  StatusState &
  StatusActions &
  Pick<GitState, 'branches' | 'remotes' | 'tags' | 'currentPR' | 'commits'>

// 创建测试用的 store
function createTestStore() {
  return create<TestState>((...args) => ({
    // Operations 状态
    operations: [],
    operationsByWs: {},

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
    ...createOperationsSlice(...args),
  }))
}

// 创建模拟的操作流水条目
function createMockOperation(
  ts: number,
  action: string,
  ok = true,
  durationMs = 120
): GitOperationEntry {
  return {
    wsPath: 'C:/repo',
    action,
    label: action,
    ok,
    durationMs,
    source: 'bootstrap',
    ts,
    gitTaskId: null,
  }
}

describe('operationsSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getOperations', () => {
    it('拉取操作流水并按 wsPath 分片写入', async () => {
      const store = createTestStore()
      const entries = [createMockOperation(2, 'commit_changes'), createMockOperation(1, 'discard_changes')]
      mockInvoke.mockResolvedValueOnce(entries)

      const result = await store.getState().getOperations('C:/repo')

      expect(mockInvoke).toHaveBeenCalledWith('git_get_operations', { workspacePath: 'C:/repo' })
      expect(result).toEqual(entries)
      expect(store.getState().operations).toEqual(entries)
      expect(store.getState().operationsByWs?.['C:/repo']).toEqual(entries)
    })

    it('拉取失败时返回空列表并记录 error', async () => {
      const store = createTestStore()
      mockInvoke.mockRejectedValueOnce(new Error('git: no repo'))

      const result = await store.getState().getOperations('C:/repo')

      expect(result).toEqual([])
      expect(store.getState().error).toBe('git: no repo')
    })
  })

  describe('clearOperations', () => {
    it('调用清空接口并本地置空', async () => {
      const store = createTestStore()
      mockInvoke.mockResolvedValueOnce(undefined)

      // 预置一条流水，验证清空后置空
      await store.getState().clearOperations('C:/repo')

      expect(mockInvoke).toHaveBeenCalledWith('git_clear_operations', { workspacePath: 'C:/repo' })
      expect(store.getState().operations).toEqual([])
      expect(store.getState().operationsByWs?.['C:/repo']).toEqual([])
      expect(store.getState().isLoading).toBe(false)
    })

    it('清空失败时抛出并记录 error', async () => {
      const store = createTestStore()
      mockInvoke.mockRejectedValueOnce(new Error('git: clear failed'))

      await expect(store.getState().clearOperations('C:/repo')).rejects.toThrow('git: clear failed')
      expect(store.getState().error).toBe('git: clear failed')
      expect(store.getState().isLoading).toBe(false)
    })
  })
})
