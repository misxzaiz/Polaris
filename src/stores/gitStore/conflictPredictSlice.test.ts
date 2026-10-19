/**
 * conflictPredictSlice 单元测试
 *
 * 测试冲突预测（FR-P2-AI4）：predictConflicts 拉取 / 失败空态。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock 统一 transport（slice 经 @/services/transport 调用后端，非 @tauri-apps/api/core）
const mockInvoke = vi.fn()
vi.mock('@/services/transport', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createConflictPredictSlice } from './conflictPredictSlice'
import type {
  GitState,
  ConflictPredictState,
  ConflictPredictActions,
  StatusState,
  StatusActions,
} from './types'
import type { GitConflictPrediction } from '@/types/git'

// 创建测试用的最小状态
type TestState = ConflictPredictState &
  ConflictPredictActions &
  StatusState &
  StatusActions &
  Pick<GitState, 'branches' | 'remotes' | 'tags' | 'currentPR' | 'commits'>

// 创建测试用的 store
function createTestStore() {
  return create<TestState>((...args) => ({
    // 冲突预测状态
    conflictPrediction: null,
    conflictPredictionsByWs: {},

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
    ...createConflictPredictSlice(...args),
  }))
}

// 创建模拟的冲突预测对象
function createMockPrediction(): GitConflictPrediction {
  return {
    branch: 'main',
    upstream: 'origin/main',
    behind: 1,
    incoming: [{ sha: '514d4f24', shortSha: '514d4f24', summary: 'c2 remote only (a.txt)' }],
    localModified: ['a.txt', 'b.txt'],
    incomingFiles: ['a.txt'],
    riskFiles: ['a.txt'],
    advice: 'commitOrStash',
  }
}

describe('conflictPredictSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('predictConflicts', () => {
    it('拉取冲突预测并按 wsPath 分片写入（branch 缺省不传）', async () => {
      const store = createTestStore()
      const prediction = createMockPrediction()
      mockInvoke.mockResolvedValueOnce(prediction)

      const result = await store.getState().predictConflicts('C:/repo')

      expect(mockInvoke).toHaveBeenCalledWith('git_predict_conflicts', { workspacePath: 'C:/repo' })
      expect(result).toEqual(prediction)
      expect(store.getState().conflictPrediction).toEqual(prediction)
      expect(store.getState().conflictPredictionsByWs?.['C:/repo']).toEqual(prediction)
    })

    it('显式传入 branch 时透传给后端', async () => {
      const store = createTestStore()
      const prediction = createMockPrediction()
      mockInvoke.mockResolvedValueOnce(prediction)

      await store.getState().predictConflicts('C:/repo', 'feature/x')

      expect(mockInvoke).toHaveBeenCalledWith('git_predict_conflicts', {
        workspacePath: 'C:/repo',
        branch: 'feature/x',
      })
    })

    it('拉取失败时返回 null（不抛错），卡片显示空态', async () => {
      const store = createTestStore()
      mockInvoke.mockRejectedValueOnce(new Error('git: no repo'))

      const result = await store.getState().predictConflicts('C:/repo')

      expect(result).toBeNull()
      expect(store.getState().error).toBe('git: no repo')
      // 失败不写入分片（保留旧值或 undefined）
      expect(store.getState().conflictPredictionsByWs?.['C:/repo']).toBeUndefined()
    })
  })
})