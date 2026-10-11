/**
 * WorkspaceSessionsSubscription 测试（S3 拉取版）
 *
 * 用 mock sessionIndexService 验证：
 * 1. start() 首拉快照写入桶
 * 2. 增量轮询应用 delta
 * 3. gap 超阈值触发 resync
 * 4. stop() 清理定时器
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock sessionIndexService
vi.mock('@/services/sessionIndexService', () => ({
  listWorkspaceSessions: vi.fn(),
  listWorkspaceSessionsAfter: vi.fn(),
}))

// Mock transport（订阅器新依赖：listen 订阅 WS 事件）
vi.mock('@/services/transport', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))

import { listen } from '@/services/transport'

/**
 * 事件分发工具：捕获 listen 注册的 handler，供测试手动触发 WS 事件。
 * 返回按事件名索引的 handler 列表。
 */
const eventHandlers = new Map<string, ((payload: unknown) => void)[]>()
;(listen as ReturnType<typeof vi.fn>).mockImplementation(
  (event: string, handler: (payload: unknown) => void) => {
    if (!eventHandlers.has(event)) eventHandlers.set(event, [])
    eventHandlers.get(event)!.push(handler)
    return Promise.resolve(() => {})
  },
)

/** 触发一次 WS 事件（模拟 transport 收到广播） */
function fireEvent(event: string, payload: unknown): void {
  for (const h of eventHandlers.get(event) ?? []) {
    h(payload)
  }
}

import {
  listWorkspaceSessions,
  listWorkspaceSessionsAfter,
} from '@/services/sessionIndexService'
import { WorkspaceSessionsSubscription } from './workspaceSessionsSubscription'
import { workspaceSessionSlice } from '@/stores/workspaceSession'

const mockedList = listWorkspaceSessions as ReturnType<typeof vi.fn>
const mockedAfter = listWorkspaceSessionsAfter as ReturnType<typeof vi.fn>

describe('WorkspaceSessionsSubscription', () => {
  beforeEach(() => {
    workspaceSessionSlice.getState().reset()
    vi.clearAllMocks()
    vi.useFakeTimers()
    eventHandlers.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('start() 首拉快照写入桶', async () => {
    mockedList.mockResolvedValue({
      sessions: [
        { sessionId: 's1', workspaceKey: '/ws', title: 'S1', status: 'idle', seq: 1, updatedAt: 1000, engineId: 'codex', createdAt: 1000 },
        { sessionId: 's2', workspaceKey: '/ws', title: 'S2', status: 'running', seq: 2, updatedAt: 2000, engineId: 'codex', createdAt: 1000 },
      ],
      lastSeq: 2,
    })
    mockedAfter.mockResolvedValue([])

    const sub = new WorkspaceSessionsSubscription('/ws')
    await sub.start()

    const bucket = workspaceSessionSlice.getState().getBucket('/ws')!
    expect(bucket).not.toBeNull()
    expect(bucket.sessionMetadata.get('s1')?.title).toBe('S1')
    expect(bucket.sessionMetadata.get('s2')?.title).toBe('S2')
    expect(sub.getState().lastSeq).toBe(2)
    expect(sub.getState().status).toBe('active')

    sub.stop()
  })

  it('start() 首拉快照清理「后端已删 + 本地未打开」的残留投影（S3 残留修复）', async () => {
    // 预置：桶内已有一批旧投影（后端表曾被填满，后被其他端清空）
    workspaceSessionSlice.getState().upsertSessionProjection('/ws', 'stale-a', { title: '残留A' })
    workspaceSessionSlice.getState().upsertSessionProjection('/ws', 'stale-b', { title: '残留B' })

    // 首拉快照：后端现在只有 s1（表已清理），本地已打开 local-open（sessionStoreManager 有实例）
    mockedList.mockResolvedValue({
      sessions: [
        { sessionId: 's1', workspaceKey: '/ws', title: 'S1', status: 'idle', seq: 1, updatedAt: 1000, engineId: 'codex', createdAt: 1000 },
      ],
      lastSeq: 1,
    })
    mockedAfter.mockResolvedValue([])

    const sub = new WorkspaceSessionsSubscription('/ws')
    await sub.start()

    const bucket = workspaceSessionSlice.getState().getBucket('/ws')!
    // 残留 stale-a / stale-b 应被清理（既不在快照、本地也无实例）
    expect(bucket.sessionMetadata.has('stale-a')).toBe(false)
    expect(bucket.sessionMetadata.has('stale-b')).toBe(false)
    expect(bucket.sessionMetadata.has('s1')).toBe(true)

    sub.stop()
  })

  it('增量轮询应用 delta + 更新 lastSeq', async () => {
    mockedList.mockResolvedValue({ sessions: [], lastSeq: 0 })
    mockedAfter.mockResolvedValue([
      { sessionId: 's3', workspaceKey: '/ws', title: 'New', status: 'idle', seq: 3, updatedAt: 3000, engineId: 'codex', createdAt: 3000 },
    ])

    const sub = new WorkspaceSessionsSubscription('/ws')
    await sub.start()

    // 触发一次轮询
    await vi.advanceTimersByTimeAsync(10001)

    const bucket = workspaceSessionSlice.getState().getBucket('/ws')!
    expect(bucket.sessionMetadata.get('s3')?.title).toBe('New')
    expect(sub.getState().lastSeq).toBe(3)

    sub.stop()
  })

  it('gap 超阈值触发 resync（重拉全量快照）', async () => {
    mockedList
      .mockResolvedValueOnce({ sessions: [], lastSeq: 0 }) // start
      .mockResolvedValueOnce({ // resync
        sessions: [
          { sessionId: 's1', workspaceKey: '/ws', title: 'Resynced', status: 'idle', seq: 100, updatedAt: 4000, engineId: 'codex', createdAt: 1000 },
        ],
        lastSeq: 100,
      })
    // 制造超阈值的 delta
    const bigDelta = Array.from({ length: 51 }, (_, i) => ({
      sessionId: `s${i}`,
      workspaceKey: '/ws',
      title: `S${i}`,
      status: 'idle' as const,
      seq: i + 1,
      updatedAt: 1000 + i,
      engineId: 'codex',
      createdAt: 1000,
    }))
    mockedAfter.mockResolvedValue(bigDelta)

    const sub = new WorkspaceSessionsSubscription('/ws')
    await sub.start()

    await vi.advanceTimersByTimeAsync(10001)

    // resync 后应看到 Resynced
    const bucket = workspaceSessionSlice.getState().getBucket('/ws')!
    expect(bucket.sessionMetadata.get('s1')?.title).toBe('Resynced')
    expect(sub.getState().lastSeq).toBe(100)

    sub.stop()
  })

  it('stop() 清理定时器（不再轮询）', async () => {
    mockedList.mockResolvedValue({ sessions: [], lastSeq: 0 })
    mockedAfter.mockResolvedValue([])

    const sub = new WorkspaceSessionsSubscription('/ws')
    await sub.start()
    expect(sub.getState().status).toBe('active')

    sub.stop()
    expect(sub.getState().status).toBe('stopped')

    const callCountBefore = mockedAfter.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockedAfter.mock.calls.length).toBe(callCountBefore)
  })

  it('WS 事件 session-index-upserted 实时 upsert 桶投影', async () => {
    mockedList.mockResolvedValue({ sessions: [], lastSeq: 0 })
    mockedAfter.mockResolvedValue([])

    const sub = new WorkspaceSessionsSubscription('/ws')
    await sub.start()

    // 触发 upserted 事件（其他端新建会话广播）
    fireEvent('session-index-upserted', {
      workspaceKey: '/ws',
      sessionId: 'remote-s1',
      projection: {
        sessionId: 'remote-s1',
        workspaceKey: '/ws',
        title: 'Remote',
        status: 'running',
        seq: 5,
        updatedAt: 5000,
        engineId: 'codex',
        createdAt: 5000,
      },
    })

    const bucket = workspaceSessionSlice.getState().getBucket('/ws')!
    expect(bucket.sessionMetadata.get('remote-s1')?.title).toBe('Remote')
    expect(sub.getState().lastSeq).toBe(5)

    sub.stop()
  })

  it('WS 事件 session-index-removed 移除桶投影（不销毁本地 store）', async () => {
    mockedList.mockResolvedValue({
      sessions: [
        { sessionId: 's1', workspaceKey: '/ws', title: 'S1', status: 'idle', seq: 1, updatedAt: 1000, engineId: 'codex', createdAt: 1000 },
      ],
      lastSeq: 1,
    })
    mockedAfter.mockResolvedValue([])

    const sub = new WorkspaceSessionsSubscription('/ws')
    await sub.start()
    expect(workspaceSessionSlice.getState().getBucket('/ws')!.sessionMetadata.has('s1')).toBe(true)

    // 触发 removed 事件（其他端删除会话广播）
    fireEvent('session-index-removed', {
      workspaceKey: '/ws',
      sessionId: 's1',
    })

    const bucket = workspaceSessionSlice.getState().getBucket('/ws')!
    expect(bucket.sessionMetadata.has('s1')).toBe(false)

    sub.stop()
  })

  it('WS 事件忽略其他 workspace 桶的变更', async () => {
    mockedList.mockResolvedValue({ sessions: [], lastSeq: 0 })
    mockedAfter.mockResolvedValue([])

    const sub = new WorkspaceSessionsSubscription('/ws')
    await sub.start()

    fireEvent('session-index-upserted', {
      workspaceKey: '/other-ws',
      sessionId: 'other-s1',
      projection: {
        sessionId: 'other-s1',
        workspaceKey: '/other-ws',
        title: 'Other',
        status: 'idle',
        seq: 1,
        updatedAt: 1000,
        engineId: 'codex',
        createdAt: 1000,
      },
    })

    const bucket = workspaceSessionSlice.getState().getBucket('/ws')!
    expect(bucket.sessionMetadata.has('other-s1')).toBe(false)

    sub.stop()
  })

  it('start 失败进入 suspended，后续轮询尝试重连', async () => {
    mockedList
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ sessions: [], lastSeq: 0 })
    mockedAfter.mockResolvedValue([])

    const sub = new WorkspaceSessionsSubscription('/ws')
    await sub.start()
    expect(sub.getState().status).toBe('suspended')

    // 轮询会调 list_after（不调 list），但 suspended 时若 list_after 成功则恢复 active
    mockedAfter.mockResolvedValue([
      { sessionId: 's1', workspaceKey: '/ws', title: 'Recovered', status: 'idle', seq: 1, updatedAt: 1000, engineId: 'codex', createdAt: 1000 },
    ])
    await vi.advanceTimersByTimeAsync(10001)
    expect(sub.getState().status).toBe('active')

    sub.stop()
  })
})
