/**
 * V2 状态权威影子验证 — 阶段 2
 *
 * 目标：验证 V2SessionEventLog / V2StateArbiter（调后端命令）的行为与
 * InMemorySessionEventLog / InMemoryStateArbiter（案例 3/4 已验证的基准）一致，
 * 且 invoke 参数契约正确（camelCase ↔ 后端命令对齐）。
 *
 * 验证方式：mock 统一 transport 的 `invoke`，用一个内存"伪后端"模拟后端
 * session_* 命令的 SQLite 语义（幂等 INSERT OR IGNORE / seq 升序 / 状态从日志计算）。
 * 跑一遍案例 3（状态计算/仲裁/并发）与案例 4（对账）的核心矩阵。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { V2SessionEventLog, V2StateArbiter } from '../core/v2-session-event-log'
import { V2MessageLog } from '../core/v2-message-log'
import { reconcile } from '../core/reconcile'
import type { MessageEntry, SessionEventEntry } from '../core/types'

// ============================================================================
// 伪后端：模拟后端 SQLite 的事件日志 + 消息日志 + 状态计算语义
// ============================================================================

interface StoredEvent extends SessionEventEntry {
  eventType?: never
}

class FakeStateBackend {
  /** 事件表：id → event（INSERT OR IGNORE 幂等） */
  events = new Map<string, StoredEvent>()
  /** 消息表：id+version → entry（复用案例 1b 的伪后端语义） */
  messages = new Map<string, MessageEntry>()
  /** seq 分配器 */
  private seqCounter = 0

  handle(command: string, args: Record<string, unknown>): unknown {
    switch (command) {
      // ── 事件 ──────────────────────────────────────────────────────────
      case 'session_event_append': {
        const evt = args as unknown as SessionEventEntry
        const id = evt.id
        if (this.events.has(id)) return false
        // 后端分配 seq（模拟 AUTOINCREMENT）
        this.seqCounter += 1
        this.events.set(id, { ...evt, seq: this.seqCounter })
        return true
      }
      case 'session_event_read': {
        const conversationId = args.conversationId as string
        return [...this.events.values()]
          .filter(e => e.conversationId === conversationId)
          .sort((a, b) => a.seq - b.seq)
      }
      case 'session_event_read_after_seq': {
        const seq = args.seq as number
        return [...this.events.values()]
          .filter(e => e.seq > seq)
          .sort((a, b) => a.seq - b.seq)
      }
      case 'session_event_current_seq': {
        return this.seqCounter
      }
      case 'session_event_delete_by_conversation': {
        const conversationId = args.conversationId as string
        for (const [key, e] of this.events) {
          if (e.conversationId === conversationId) this.events.delete(key)
        }
        return null
      }
      // ── 状态 ──────────────────────────────────────────────────────────
      case 'session_get_status': {
        const conversationId = args.conversationId as string
        const events = [...this.events.values()]
          .filter(e => e.conversationId === conversationId)
          .sort((a, b) => a.seq - b.seq)
        return computeStatus(conversationId, events)
      }
      case 'session_request_start': {
        const conversationId = args.conversationId as string
        const status = this.handle('session_get_status', { conversationId }) as SessionStatusLike
        if (status.running) {
          return { ok: false, reason: `会话已在运行中（由设备 ${status.startedByDevice} 于 ${status.startedAt} 启动）` }
        }
        return { ok: true }
      }
      case 'session_request_interrupt': {
        const conversationId = args.conversationId as string
        const status = this.handle('session_get_status', { conversationId }) as SessionStatusLike
        if (!status.running) return { ok: false, reason: '会话未在运行中' }
        return { ok: true }
      }
      // ── 消息（复用案例 1b 语义，供对账） ───────────────────────────────
      case 'message_append': {
        const entry = args as unknown as MessageEntry
        const key = `${entry.id}#${entry.version}`
        if (this.messages.has(key)) return false
        this.messages.set(key, entry)
        return true
      }
      case 'message_read': {
        const conversationId = args.conversationId as string
        const latestByMessage = new Map<string, MessageEntry>()
        for (const e of this.messages.values()) {
          if (e.conversationId !== conversationId) continue
          const cur = latestByMessage.get(e.id)
          if (!cur || e.version > cur.version) latestByMessage.set(e.id, e)
        }
        return [...latestByMessage.values()].sort((a, b) => a.timestamp - b.timestamp)
      }
      default:
        throw new Error(`Unknown command: ${command}`)
    }
  }
}

/** 简化状态类型（camelCase，与后端 SessionStatus 对齐） */
interface SessionStatusLike {
  conversationId: string
  running: boolean
  lastEventSeq: number
  error: string | null
  startedAt: number | null
  endedAt: number | null
  startedByDevice: string | null
}

/** 后端状态计算（与 Rust compute_status_from_events 同语义） */
function computeStatus(
  conversationId: string,
  events: SessionEventEntry[],
): SessionStatusLike {
  let lastStart: SessionEventEntry | null = null
  let lastEnd: SessionEventEntry | null = null
  let lastError: SessionEventEntry | null = null
  let lastSeq = 0

  for (const e of events) {
    lastSeq = Math.max(lastSeq, e.seq)
    if (e.type === 'session_start') {
      lastStart = e
      lastEnd = null
      lastError = null
    } else if (e.type === 'session_end') {
      if (lastStart) lastEnd = e
    } else if (e.type === 'error') {
      lastError = e
    }
  }

  const running = lastStart !== null && lastEnd === null

  return {
    conversationId,
    running,
    lastEventSeq: lastSeq,
    error:
      lastError?.errorMessage ??
      lastEnd?.errorMessage ??
      (lastEnd?.reason === 'error' ? '会话以错误结束' : null),
    startedAt: running ? lastStart!.timestamp : null,
    endedAt: lastEnd?.timestamp ?? null,
    startedByDevice: running ? lastStart!.deviceId : null,
  }
}

// ============================================================================
// mock 统一 transport
// ============================================================================

const commandHandlers = new Map<string, (args: Record<string, unknown>) => unknown>()

vi.mock('@/services/transport', () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const handler = commandHandlers.get(cmd)
    if (!handler) return Promise.reject(new Error(`Unknown command: ${cmd}`))
    return Promise.resolve(handler(args ?? {}))
  }),
}))

let seqCounter = 0
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
    seq: 0, // 后端分配
    ...extra,
  }
}

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

describe('V2 状态权威影子验证（后端事件日志 + 仲裁 + 对账）', () => {
  let eventLog: V2SessionEventLog
  let arbiter: V2StateArbiter
  let messageLog: V2MessageLog
  let backend: FakeStateBackend

  beforeEach(() => {
    seqCounter = 0
    backend = new FakeStateBackend()
    // 注册全部命令处理器
    for (const cmd of [
      'session_event_append',
      'session_event_read',
      'session_event_read_after_seq',
      'session_event_current_seq',
      'session_event_delete_by_conversation',
      'session_get_status',
      'session_request_start',
      'session_request_interrupt',
      'message_append',
      'message_read',
    ]) {
      commandHandlers.set(cmd, (args) => backend.handle(cmd, args))
    }
    eventLog = new V2SessionEventLog()
    arbiter = new V2StateArbiter()
    messageLog = new V2MessageLog()
  })

  // ==========================================================================
  // 状态计算（案例 3 核心矩阵）
  // ==========================================================================

  it('无事件 → running=false', async () => {
    const status = await arbiter.getStatus('conv-1')
    expect(status.running).toBe(false)
    expect(status.startedAt).toBeNull()
    expect(status.endedAt).toBeNull()
    expect(status.error).toBeNull()
  })

  it('只有 session_start → running=true', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'device-A', 1000))
    const status = await arbiter.getStatus('conv-1')
    expect(status.running).toBe(true)
    expect(status.startedAt).toBe(1000)
    expect(status.startedByDevice).toBe('device-A')
  })

  it('start → end → running=false', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))
    await eventLog.append(makeEvent('conv-1', 'session_end', 'A', 2000, { reason: 'completed' }))
    const status = await arbiter.getStatus('conv-1')
    expect(status.running).toBe(false)
    expect(status.endedAt).toBe(2000)
  })

  it('多轮会话：第二轮 start 后 running=true（状态从日志计算）', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))
    await eventLog.append(makeEvent('conv-1', 'session_end', 'A', 2000))
    await eventLog.append(makeEvent('conv-1', 'session_start', 'B', 3000))
    const status = await arbiter.getStatus('conv-1')
    expect(status.running).toBe(true)
    expect(status.startedByDevice).toBe('B')
    expect(status.lastEventSeq).toBe(3)
  })

  it('error 事件 → error 字段有值', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))
    await eventLog.append(makeEvent('conv-1', 'error', 'A', 1500, { errorMessage: '模型超时' }))
    const status = await arbiter.getStatus('conv-1')
    expect(status.running).toBe(true)
    expect(status.error).toBe('模型超时')
  })

  // ==========================================================================
  // 仲裁（案例 3 仲裁矩阵）
  // ==========================================================================

  it('requestStart：running → 拒绝', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))
    const r = await arbiter.requestStart('conv-1', 'B')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('运行中')
  })

  it('requestStart：idle → 允许', async () => {
    const r = await arbiter.requestStart('conv-1', 'A')
    expect(r.ok).toBe(true)
  })

  it('requestInterrupt：running → 允许', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))
    const r = await arbiter.requestInterrupt('conv-1', 'B')
    expect(r.ok).toBe(true)
  })

  it('requestInterrupt：idle → 拒绝', async () => {
    const r = await arbiter.requestInterrupt('conv-1', 'A')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('未在运行')
  })

  it('两设备并发：B 在 A 启动后 requestStart → 拒绝（排他）', async () => {
    await eventLog.append(makeEvent('conv-race', 'session_start', 'A', 1000))
    const r = await arbiter.requestStart('conv-race', 'B')
    expect(r.ok).toBe(false)
  })

  it('双设备连续轮次：A 占位 → end 释放 → B 可继续 → end 释放 → A 再可继续', async () => {
    const CONV = 'conv-rounds'
    // 轮次 1：A 请求获准
    const r1 = await arbiter.requestStart(CONV, 'A')
    expect(r1.ok).toBe(true)
    // dispatch 链路占位写入（session_try_start 事务语义：获准即写 session_start）
    await eventLog.append(makeEvent(CONV, 'session_start', 'A', 1000))
    // B 被拒（running 中）
    const r2 = await arbiter.requestStart(CONV, 'B')
    expect(r2.ok).toBe(false)
    // A 结束释放
    await eventLog.append(makeEvent(CONV, 'session_end', 'A', 2000, { reason: 'completed' }))
    // 轮次 2：B 可继续（锁释放）
    const r3 = await arbiter.requestStart(CONV, 'B')
    expect(r3.ok).toBe(true)
    await eventLog.append(makeEvent(CONV, 'session_start', 'B', 3000))
    const status = await arbiter.getStatus(CONV)
    expect(status.running).toBe(true)
    expect(status.startedByDevice).toBe('B')
  })

  it('跨设备中断权限：running 由 A 发起，B 可 interrupt（与发起方解耦）', async () => {
    // 排他锁只约束 active 写（start），interrupt 是配对关闭，任何设备可发起
    await eventLog.append(makeEvent('conv-intr', 'session_start', 'A', 1000))
    const r = await arbiter.requestInterrupt('conv-intr', 'B')
    expect(r.ok).toBe(true)
    // interrupt 后仍由发起方 B 写 end → 状态收敛 idle
    await eventLog.append(makeEvent('conv-intr', 'session_end', 'B', 2000, { reason: 'aborted' }))
    const status = await arbiter.getStatus('conv-intr')
    expect(status.running).toBe(false)
  })

  // ==========================================================================
  // 事件日志接口（幂等 / seq / resume / 隔离）
  // ==========================================================================

  it('相同事件 ID 重复追加 → 幂等跳过', async () => {
    const evt = makeEvent('conv-1', 'session_start', 'A', 1000)
    const r1 = await eventLog.append(evt)
    const r2 = await eventLog.append(evt)
    expect(r1).toBe(true)
    expect(r2).toBe(false)
  })

  it('readAfterSeq：返回指定 seq 之后的事件', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))
    await eventLog.append(makeEvent('conv-1', 'error', 'A', 1500))
    await eventLog.append(makeEvent('conv-1', 'session_end', 'A', 2000))
    await eventLog.append(makeEvent('conv-2', 'session_start', 'B', 3000))

    const after = await eventLog.readAfterSeq(2)
    expect(after.length).toBe(2)
    expect(after[0].seq).toBe(3)
    expect(after[1].seq).toBe(4)
  })

  it('deleteByConversation 只删目标会话事件', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))
    await eventLog.append(makeEvent('conv-2', 'session_start', 'B', 2000))
    await eventLog.deleteByConversation('conv-1')

    const s1 = await arbiter.getStatus('conv-1')
    const s2 = await arbiter.getStatus('conv-2')
    expect(s1.running).toBe(false)
    expect(s2.running).toBe(true)
  })

  // ==========================================================================
  // 对账（案例 4 核心矩阵，走 V2MessageLog + V2StateArbiter）
  // ==========================================================================

  it('前端缺失消息 → missing 正确返回', async () => {
    const CONV = 'conv-rec-1'
    await messageLog.append(makeMsg('M1', CONV, 'user', 1000, 'A'))
    await messageLog.append(makeMsg('M2', CONV, 'assistant', 2000, 'A'))
    await messageLog.append(makeMsg('M3', CONV, 'user', 3000, 'A'))

    const clientMessages = [
      makeMsg('M1', CONV, 'user', 1000, 'A'),
      makeMsg('M2', CONV, 'assistant', 2000, 'A'),
    ]
    const result = await reconcile(messageLog, eventLog, arbiter, CONV, clientMessages, false)
    expect(result.missing.length).toBe(1)
    expect(result.missing[0].id).toBe('M3')
    expect(result.extra).toEqual([])
  })

  it('前端多出本地草稿 → extra 返回，不删除', async () => {
    const CONV = 'conv-rec-2'
    await messageLog.append(makeMsg('M1', CONV, 'user', 1000, 'A'))
    const clientMessages = [
      makeMsg('M1', CONV, 'user', 1000, 'A'),
      makeMsg('D1', CONV, 'user', 5000, 'B', { text: '草稿' }),
    ]
    const result = await reconcile(messageLog, eventLog, arbiter, CONV, clientMessages, false)
    expect(result.missing).toEqual([])
    expect(result.extra.length).toBe(1)
    expect(result.extra[0].id).toBe('D1')
  })

  it('状态不一致：前端 running 但后端 idle → statusMismatch=true', async () => {
    const CONV = 'conv-rec-3'
    await eventLog.append(makeEvent(CONV, 'session_start', 'A', 1000))
    await eventLog.append(makeEvent(CONV, 'session_end', 'A', 2000, { reason: 'completed' }))
    const result = await reconcile(messageLog, eventLog, arbiter, CONV, [], true)
    expect(result.statusMismatch).toBe(true)
    expect(result.serverStatus.running).toBe(false)
  })

  it('完整修复流程：对账发现缺失 → 补齐 → 再对账无差异', async () => {
    const CONV = 'conv-rec-4'
    for (let i = 0; i < 5; i++) {
      await messageLog.append(makeMsg(`M${i}`, CONV, 'user', 1000 + i, 'A'))
    }
    let clientMessages: MessageEntry[] = [
      makeMsg('M0', CONV, 'user', 1000, 'A'),
      makeMsg('M1', CONV, 'user', 2000, 'A'),
    ]
    const r1 = await reconcile(messageLog, eventLog, arbiter, CONV, clientMessages, false)
    expect(r1.missing.length).toBe(3)

    clientMessages = [...clientMessages, ...r1.missing]
    const r2 = await reconcile(messageLog, eventLog, arbiter, CONV, clientMessages, false)
    expect(r2.missing).toEqual([])
    expect(r2.extra).toEqual([])
    expect(r2.statusMismatch).toBe(false)
  })
})
