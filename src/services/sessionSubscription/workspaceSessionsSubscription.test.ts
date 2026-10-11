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

  it('增量轮询应用 delta + 更新 lastSeq', async () => {
    mockedList.mockResolvedValue({ sessions: [], lastSeq: 0 })
    mockedAfter.mockResolvedValue([
      { sessionId: 's3', workspaceKey: '/ws', title: 'New', status: 'idle', seq: 3, updatedAt: 3000, engineId: 'codex', createdAt: 3000 },
    ])

    const sub = new WorkspaceSessionsSubscription('/ws')
    await sub.start()

    // 触发一次轮询
    await vi.advanceTimersByTimeAsync(5001)

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

    await vi.advanceTimersByTimeAsync(5001)

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
    await vi.advanceTimersByTimeAsync(5001)
    expect(sub.getState().status).toBe('active')

    sub.stop()
  })
})
