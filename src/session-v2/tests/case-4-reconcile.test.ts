/**
 * 案例 4：对账差异修复验证
 *
 * 验证假设 4：reconcile 能发现并修复差异
 *
 * 场景：
 * - 前端缺失消息（断线期间后端有新消息）→ missing 正确返回
 * - 前端多出消息（本地草稿未同步）→ extra 正确返回，不删除
 * - 状态不一致（前端认为 running 但后端已结束）→ statusMismatch=true
 * - 修复后再次对账 → 无差异
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryMessageLog } from '../core/in-memory-log'
import { InMemorySessionEventLog, InMemoryStateArbiter } from '../core/in-memory-state'
import { reconcile } from '../core/reconcile'
import type { MessageEntry, SessionEventEntry } from '../core/types'

let seqCounter = 0

function makeMsg(
  id: string,
  conversationId: string,
  role: 'user' | 'assistant' | 'system',
  timestamp: number,
  deviceId: string,
  content: Record<string, unknown> = {},
): MessageEntry {
  return { id, conversationId, role, timestamp, deviceId, content, version: 1 }
}

function makeEvent(
  conversationId: string,
  type: 'session_start' | 'session_end' | 'error',
  deviceId: string,
  timestamp: number,
  extra?: Partial<SessionEventEntry>,
): SessionEventEntry {
  return {
    id: `evt-${++seqCounter}`,
    conversationId,
    type,
    timestamp,
    deviceId,
    seq: seqCounter,
    ...extra,
  }
}

describe('案例 4：对账差异修复', () => {
  let messageLog: InMemoryMessageLog
  let eventLog: InMemorySessionEventLog
  let arbiter: InMemoryStateArbiter
  const CONV = 'conv-reconcile-001'

  beforeEach(() => {
    seqCounter = 0
    messageLog = new InMemoryMessageLog()
    eventLog = new InMemorySessionEventLog()
    arbiter = new InMemoryStateArbiter(eventLog)
  })

  // ==========================================================================
  // 无差异
  // ==========================================================================

  it('前端与后端一致 → 无差异', async () => {
    await messageLog.append(makeMsg('M1', CONV, 'user', 1000, 'A'))
    await messageLog.append(makeMsg('M2', CONV, 'assistant', 2000, 'A'))

    const clientMessages = [
      makeMsg('M1', CONV, 'user', 1000, 'A'),
      makeMsg('M2', CONV, 'assistant', 2000, 'A'),
    ]

    const result = await reconcile(messageLog, eventLog, arbiter, CONV, clientMessages, false)

    expect(result.missing).toEqual([])
    expect(result.extra).toEqual([])
    expect(result.statusMismatch).toBe(false)
  })

  // ==========================================================================
  // 前端缺失消息
  // ==========================================================================

  it('前端缺失 2 条消息 → missing 正确返回', async () => {
    await messageLog.append(makeMsg('M1', CONV, 'user', 1000, 'A'))
    await messageLog.append(makeMsg('M2', CONV, 'assistant', 2000, 'A'))
    await messageLog.append(makeMsg('M3', CONV, 'user', 3000, 'A'))
    await messageLog.append(makeMsg('M4', CONV, 'assistant', 4000, 'A'))

    // 前端只有 M1, M2（断线期间丢失了 M3, M4）
    const clientMessages = [
      makeMsg('M1', CONV, 'user', 1000, 'A'),
      makeMsg('M2', CONV, 'assistant', 2000, 'A'),
    ]

    const result = await reconcile(messageLog, eventLog, arbiter, CONV, clientMessages, false)

    expect(result.missing.length).toBe(2)
    expect(result.missing.map(m => m.id)).toEqual(['M3', 'M4'])
    expect(result.extra).toEqual([])
  })

  it('修复缺失后再次对账 → 无差异', async () => {
    await messageLog.append(makeMsg('M1', CONV, 'user', 1000, 'A'))
    await messageLog.append(makeMsg('M2', CONV, 'assistant', 2000, 'A'))

    // 第一次对账：前端空
    const r1 = await reconcile(messageLog, eventLog, arbiter, CONV, [], false)
    expect(r1.missing.length).toBe(2)

    // 模拟修复：前端拉取后端完整消息
    const fixed = await messageLog.read(CONV)
    const r2 = await reconcile(messageLog, eventLog, arbiter, CONV, fixed, false)

    expect(r2.missing).toEqual([])
    expect(r2.extra).toEqual([])
  })

  // ==========================================================================
  // 前端多出消息（本地草稿未同步）
  // ==========================================================================

  it('前端多出 1 条草稿 → extra 正确返回，不被标记为 missing', async () => {
    await messageLog.append(makeMsg('M1', CONV, 'user', 1000, 'A'))

    // 前端有 M1 + 本地草稿 D1（还没同步到后端）
    const clientMessages = [
      makeMsg('M1', CONV, 'user', 1000, 'A'),
      makeMsg('D1', CONV, 'user', 5000, 'B', { text: '待发送的草稿' }),
    ]

    const result = await reconcile(messageLog, eventLog, arbiter, CONV, clientMessages, false)

    expect(result.missing).toEqual([])
    expect(result.extra.length).toBe(1)
    expect(result.extra[0].id).toBe('D1')
  })

  // ==========================================================================
  // 状态不一致
  // ==========================================================================

  it('前端认为 running 但后端已结束 → statusMismatch=true', async () => {
    await eventLog.append(makeEvent(CONV, 'session_start', 'A', 1000))
    await eventLog.append(makeEvent(CONV, 'session_end', 'A', 2000, { reason: 'completed' }))

    // 前端错过了 session_end，仍然认为 running=true
    const result = await reconcile(messageLog, eventLog, arbiter, CONV, [], true)

    expect(result.statusMismatch).toBe(true)
    expect(result.serverStatus.running).toBe(false)
  })

  it('前端认为 idle 且后端也 idle → statusMismatch=false', async () => {
    const result = await reconcile(messageLog, eventLog, arbiter, CONV, [], false)
    expect(result.statusMismatch).toBe(false)
  })

  it('前端认为 idle 但后端正在 running → statusMismatch=true', async () => {
    await eventLog.append(makeEvent(CONV, 'session_start', 'A', 1000))

    // 前端不知道后端正在运行（如刚打开页面）
    const result = await reconcile(messageLog, eventLog, arbiter, CONV, [], false)

    expect(result.statusMismatch).toBe(true)
    expect(result.serverStatus.running).toBe(true)
    expect(result.serverStatus.startedByDevice).toBe('A')
  })

  // ==========================================================================
  // 组合场景：消息缺失 + 状态不一致
  // ==========================================================================

  it('断线 30s 恢复：缺失消息 + 状态不一致 → 同时返回', async () => {
    // 后端：有 3 条消息 + 会话已结束
    await messageLog.append(makeMsg('M1', CONV, 'user', 1000, 'A'))
    await messageLog.append(makeMsg('M2', CONV, 'assistant', 2000, 'A'))
    await messageLog.append(makeMsg('M3', CONV, 'assistant', 3000, 'A'))

    await eventLog.append(makeEvent(CONV, 'session_start', 'A', 1000))
    await eventLog.append(makeEvent(CONV, 'session_end', 'A', 3500, { reason: 'completed' }))

    // 前端：只有 M1，仍然认为 running（断线于 1000ms 时）
    const clientMessages = [makeMsg('M1', CONV, 'user', 1000, 'A')]

    const result = await reconcile(messageLog, eventLog, arbiter, CONV, clientMessages, true)

    expect(result.missing.length).toBe(2) // M2, M3
    expect(result.statusMismatch).toBe(true) // 前端 running，后端 idle
    expect(result.serverStatus.running).toBe(false)
    expect(result.serverStatus.endedAt).toBe(3500)
  })

  // ==========================================================================
  // 修复流程验证：对账 → 补齐 → 再对账
  // ==========================================================================

  it('完整修复流程：对账发现缺失 → 补齐 → 再对账无差异', async () => {
    // 后端有 5 条消息
    for (let i = 0; i < 5; i++) {
      await messageLog.append(makeMsg(`M${i}`, CONV, 'user', 1000 + i, 'A'))
    }

    // 前端只有 3 条
    let clientMessages = [
      makeMsg('M0', CONV, 'user', 1000, 'A'),
      makeMsg('M1', CONV, 'user', 2000, 'A'),
      makeMsg('M2', CONV, 'user', 3000, 'A'),
    ]

    // 第一次对账：缺失 2 条
    const r1 = await reconcile(messageLog, eventLog, arbiter, CONV, clientMessages, false)
    expect(r1.missing.length).toBe(2)

    // 修复：把缺失消息追加到前端
    clientMessages = [...clientMessages, ...r1.missing]

    // 第二次对账：无差异
    const r2 = await reconcile(messageLog, eventLog, arbiter, CONV, clientMessages, false)
    expect(r2.missing).toEqual([])
    expect(r2.extra).toEqual([])
    expect(r2.statusMismatch).toBe(false)
  })

  // ==========================================================================
  // 边界
  // ==========================================================================

  it('前后端都空 → 无差异', async () => {
    const result = await reconcile(messageLog, eventLog, arbiter, CONV, [], false)
    expect(result.missing).toEqual([])
    expect(result.extra).toEqual([])
    expect(result.statusMismatch).toBe(false)
  })

  it('后端空但前端有消息 → 全部标记为 extra', async () => {
    const clientMessages = [
      makeMsg('X1', CONV, 'user', 1000, 'A'),
      makeMsg('X2', CONV, 'user', 2000, 'A'),
    ]

    const result = await reconcile(messageLog, eventLog, arbiter, CONV, clientMessages, false)
    expect(result.extra.length).toBe(2)
    expect(result.missing).toEqual([])
  })

  it('前端空但后端有消息 → 全部标记为 missing', async () => {
    await messageLog.append(makeMsg('M1', CONV, 'user', 1000, 'A'))
    await messageLog.append(makeMsg('M2', CONV, 'user', 2000, 'A'))

    const result = await reconcile(messageLog, eventLog, arbiter, CONV, [], false)
    expect(result.missing.length).toBe(2)
    expect(result.extra).toEqual([])
  })

  // ==========================================================================
  // 性能
  // ==========================================================================

  it('1000 条消息对账 < 10ms', async () => {
    for (let i = 0; i < 1000; i++) {
      await messageLog.append(makeMsg(`M${i}`, CONV, 'user', i, 'A'))
    }

    // 前端有 990 条（缺 10 条）
    const clientMessages: MessageEntry[] = []
    for (let i = 0; i < 990; i++) {
      clientMessages.push(makeMsg(`M${i}`, CONV, 'user', i, 'A'))
    }

    const start = performance.now()
    const result = await reconcile(messageLog, eventLog, arbiter, CONV, clientMessages, false)
    const elapsed = performance.now() - start

    console.log(`1000 条消息对账: ${elapsed.toFixed(2)}ms`)
    expect(elapsed).toBeLessThan(10)
    expect(result.missing.length).toBe(10)
  })
})
