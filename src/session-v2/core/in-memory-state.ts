/**
 * InMemorySessionEventLog + InMemoryStateArbiter — 层 1 验证用
 *
 * 事件日志 append-only，状态从日志计算。
 * 验证"状态是计算结果不是存储值"的可靠性。
 */

import type {
  SessionEventEntry,
  SessionEventLog,
  SessionStatus,
  StateArbiter,
} from './types'

// ============================================================================
// InMemorySessionEventLog
// ============================================================================

export class InMemorySessionEventLog implements SessionEventLog {
  private events: SessionEventEntry[] = []
  private byConversation = new Map<string, SessionEventEntry[]>()
  private maxSeq = 0
  private seenIds = new Set<string>()

  async append(event: SessionEventEntry): Promise<boolean> {
    if (this.seenIds.has(event.id)) return false
    this.seenIds.add(event.id)

    this.events.push(event)
    if (event.seq > this.maxSeq) this.maxSeq = event.seq

    const list = this.byConversation.get(event.conversationId) ?? []
    list.push(event)
    list.sort((a, b) => a.seq - b.seq)
    this.byConversation.set(event.conversationId, list)

    return true
  }

  async read(conversationId: string): Promise<SessionEventEntry[]> {
    return [...(this.byConversation.get(conversationId) ?? [])]
  }

  async readAfterSeq(seq: number): Promise<SessionEventEntry[]> {
    return this.events.filter(e => e.seq > seq)
  }

  currentSeq(): number {
    return this.maxSeq
  }

  async deleteByConversation(conversationId: string): Promise<void> {
    const list = this.byConversation.get(conversationId) ?? []
    for (const e of list) {
      this.seenIds.delete(e.id)
    }
    this.byConversation.delete(conversationId)
    this.events = this.events.filter(e => e.conversationId !== conversationId)
  }

  /** 测试辅助：分配下一个 seq */
  nextSeq(): number {
    return ++this.maxSeq
  }
}

// ============================================================================
// InMemoryStateArbiter
// ============================================================================

/**
 * 从事件日志计算会话状态
 *
 * 核心逻辑：
 * - running = 存在未配对的 session_start（即最后一个 session_start 之后没有 session_end）
 * - error = 最后一条 error 事件的信息
 * - startedAt = 最后一个未配对 session_start 的 timestamp
 * - startedByDevice = 最后一个未配对 session_start 的 deviceId
 */
function computeStatus(events: SessionEventEntry[]): SessionStatus | null {
  if (events.length === 0) return null

  // 按 seq 升序遍历，追踪 session_start / session_end 配对
  let lastStart: SessionEventEntry | null = null
  let lastEnd: SessionEventEntry | null = null
  let lastError: SessionEventEntry | null = null
  let lastSeq = 0

  for (const e of events) {
    lastSeq = Math.max(lastSeq, e.seq)
    if (e.type === 'session_start') {
      lastStart = e
      lastEnd = null // 重置：新的 start 配对等待新的 end
      lastError = null
    } else if (e.type === 'session_end') {
      if (lastStart) {
        lastEnd = e
      }
    } else if (e.type === 'error') {
      lastError = e
    }
  }

  const running = lastStart !== null && lastEnd === null

  return {
    conversationId: events[0].conversationId,
    running,
    lastEventSeq: lastSeq,
    error: lastError?.errorMessage ?? lastEnd?.errorMessage ?? (lastEnd?.reason === 'error' ? '会话以错误结束' : null),
    startedAt: running ? lastStart!.timestamp : null,
    endedAt: lastEnd?.timestamp ?? null,
    startedByDevice: running ? lastStart!.deviceId : null,
  }
}

export class InMemoryStateArbiter implements StateArbiter {
  constructor(private eventLog: SessionEventLog) {}

  async getStatus(conversationId: string): Promise<SessionStatus> {
    const events = await this.eventLog.read(conversationId)
    const status = computeStatus(events)
    if (!status) {
      return {
        conversationId,
        running: false,
        lastEventSeq: 0,
        error: null,
        startedAt: null,
        endedAt: null,
        startedByDevice: null,
      }
    }
    return status
  }

  async requestStart(conversationId: string, _deviceId: string): Promise<{ ok: boolean; reason?: string }> {
    const status = await this.getStatus(conversationId)
    if (status.running) {
      return {
        ok: false,
        reason: `会话已在运行中（由设备 ${status.startedByDevice} 于 ${new Date(status.startedAt!).toISOString()} 启动）`,
      }
    }
    // 仲裁通过：实际 start 由调用方执行（追加 session_start 事件）
    return { ok: true }
  }

  async requestInterrupt(conversationId: string, _deviceId: string): Promise<{ ok: boolean; reason?: string }> {
    const status = await this.getStatus(conversationId)
    if (!status.running) {
      return { ok: false, reason: '会话未在运行中' }
    }
    // 能力检查：发起方设备有权中断，或者全局允许（当前实现：任何设备都可中断）
    // 未来可加策略：只有 startedByDevice 才能中断
    return { ok: true }
  }
}
