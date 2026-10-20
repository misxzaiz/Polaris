/**
 * FR-P2-4 · operationsSubscriber 单元测试
 *
 * 验收（spec §四）：
 * - git-operation 事件到达 → prepend 到对应 ws 分片（最新置顶）
 * - 事件 ws 为当前生效仓库 → 同步 mirror 域 operations
 * - 非生效仓库事件 → 只写分片不碰 mirror 域
 * - 超过上限 50 → 保留最新 50 条
 * - 载荷缺 wsPath → 跳过
 * - cleanup 取消监听；cleanup 后事件不再写入
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- mocks ---
const mockListen = vi.fn()
vi.mock('@/services/transport', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

// 模拟 gitStore：getState 返回可变状态，setState 触发状态写入
let mockState: Record<string, unknown>
const mockSetState = vi.fn()
vi.mock('@/stores/gitStore', () => ({
  useGitStore: {
    getState: () => mockState,
    setState: (patch: unknown) => {
      mockSetState(patch)
      // 同步把 patch 应用到 mockState（模拟 zustand 行为，供后续 getState 读到）
      Object.assign(mockState, patch)
    },
  },
}))

// Import after mocking
import { initOperationsSubscriber } from './operationsSubscriber'
import type { GitOperationEntry } from '@/types/git'

function captureHandler() {
  const listenArgs = mockListen.mock.calls[0]!
  return listenArgs[1] as (e: GitOperationEntry) => void
}

// 创建模拟的操作流水条目
function createMockOperation(ts: number, action: string): GitOperationEntry {
  return {
    wsPath: 'C:/repo',
    action,
    label: action,
    ok: true,
    durationMs: 100,
    source: 'bootstrap',
    ts,
    gitTaskId: null,
  }
}

describe('operationsSubscriber (FR-P2-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListen.mockResolvedValue(() => {})
    mockState = {
      operations: [],
      operationsByWs: {},
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('事件到达 → prepend 到对应 ws 分片（最新置顶）', () => {
    initOperationsSubscriber(() => null)
    const handler = captureHandler()
    expect(mockListen.mock.calls[0]![0]).toBe('git-operation')

    handler(createMockOperation(1, 'commit_changes'))
    handler(createMockOperation(2, 'discard_changes'))

    const byWs = mockState.operationsByWs as Record<string, GitOperationEntry[]>
    expect(byWs['C:/repo']).toHaveLength(2)
    // 后到的事件在最上（倒序：新→旧）
    expect(byWs['C:/repo']![0].action).toBe('discard_changes')
    expect(byWs['C:/repo']![1].action).toBe('commit_changes')
  })

  it('事件 ws 为当前生效仓库 → 同步 mirror 域 operations', () => {
    initOperationsSubscriber(() => 'C:/repo')
    const handler = captureHandler()

    handler(createMockOperation(1, 'stage_file'))

    expect(mockState.operations).toHaveLength(1)
    expect((mockState.operations as GitOperationEntry[])[0].action).toBe('stage_file')
  })

  it('非生效仓库事件 → 只写分片不碰 mirror 域', () => {
    mockState.operations = [createMockOperation(9, 'existing')]
    initOperationsSubscriber(() => 'C:/other')
    const handler = captureHandler()

    handler(createMockOperation(1, 'stage_file'))

    // mirror 域保持原样
    expect(mockState.operations).toHaveLength(1)
    expect((mockState.operations as GitOperationEntry[])[0].action).toBe('existing')
    // 分片已写
    const byWs = mockState.operationsByWs as Record<string, GitOperationEntry[]>
    expect(byWs['C:/repo']![0].action).toBe('stage_file')
  })

  it('超过上限 50 → 保留最新 50 条', () => {
    initOperationsSubscriber(() => 'C:/repo')
    const handler = captureHandler()

    // 51 条事件（倒序插入，最新在最前）
    for (let i = 0; i < 51; i++) {
      handler(createMockOperation(i, `op_${i}`))
    }

    const byWs = mockState.operationsByWs as Record<string, GitOperationEntry[]>
    expect(byWs['C:/repo']).toHaveLength(50)
    // 最新的一条（op_50）在顶部
    expect(byWs['C:/repo']![0].action).toBe('op_50')
  })

  it('载荷缺 wsPath → 跳过', () => {
    initOperationsSubscriber(() => 'C:/repo')
    const handler = captureHandler()

    handler({ ...createMockOperation(1, 'x'), wsPath: '' })
    expect(mockSetState).not.toHaveBeenCalled()
  })

  it('cleanup 取消监听；cleanup 后事件不再写入', () => {
    const cleanup = initOperationsSubscriber(() => 'C:/repo')
    const handler = captureHandler()

    cleanup()
    handler(createMockOperation(1, 'stage_file'))
    expect(mockSetState).not.toHaveBeenCalled()
  })
})
