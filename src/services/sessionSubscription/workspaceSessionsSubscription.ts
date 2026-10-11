/**
 * WorkspaceSessionsSubscription（S3 · 事件驱动 + 拉取兜底）
 *
 * 对齐 ZCode subscribeSessionsIndexV4 / onDynamicSessionsIndexFrame
 * （首拉快照 + 增量帧 + gap repair + 乐观合并）。
 *
 * 数据源双轨：
 * - 事件驱动：后端 register/delete 成功后广播 `session-index-upserted` / `session-index-removed`
 *   （Web 端经 WS 收到，桌面端经 relay 转推），实时应用增量（含删除——拉取版不可见）。
 * - 拉取兜底：周期 list_after(lastSeq) 修正丢帧/gap（list_index_after 仅返回 upsert 行，
 *   删除由事件补齐，故拉取只做增量 upsert 校正，不覆盖删除）。
 *
 * 职责：
 * - 桶激活时 start()：首拉快照写入桶 + 订阅 WS 事件 + 进入增量轮询兜底
 * - 事件应用：upserted → upsert 桶投影；removed → 移除桶投影
 * - gap repair：seq 跳跃 → 全量快照重拉
 * - 桶失活时 stop()：退订 WS + 清定时器，无泄漏
 *
 * 设计约束（spec §6 风险）：
 * - 乐观合并：本端命令的乐观状态与后端帧冲突时，以帧为准
 * - 时序：首拉快照与事件之间用 lastSeq 保证连续性（WS 事件自带全局 seq，由 transport 去重）
 * - 不动 eventRouter / V2SessionKernel 轮询（S3 收尾项）
 */

import {
  listWorkspaceSessions,
  listWorkspaceSessionsAfter,
  type SessionProjection,
  type WorkspaceSessionsSnapshot,
} from '@/services/sessionIndexService'
import { listen } from '@/services/transport'
import { workspaceSessionSlice } from '@/stores/workspaceSession'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { useViewStore } from '@/stores/index'
import { createLogger } from '@/utils/logger'

const log = createLogger('WorkspaceSessionsSubscription')

/** 增量轮询兜底间隔（ms）。事件驱动为主，轮询只做丢帧修正，周期放宽。 */
const POLL_INTERVAL_MS = 10_000

/** gap 阈值：增量帧数超过此值认为丢失过多，回退全量快照。 */
const GAP_THRESHOLD = 50

/** 会话索引广播事件名（对齐后端 event_broadcast 广播 + 桌面 relay 白名单）。 */
const EVENT_UPSERTED = 'session-index-upserted'
const EVENT_REMOVED = 'session-index-removed'

// ============================================================================
// 订阅状态机
// ============================================================================

export type SubscriptionStatus = 'idle' | 'connecting' | 'active' | 'suspended' | 'stopped'

export interface SubscriptionState {
  workspaceKey: string
  status: SubscriptionStatus
  lastSeq: number
  connected: boolean
}

/** WS 事件 payload 结构（对齐后端广播 JSON）。 */
interface SessionIndexEvent {
  workspaceKey: string
  sessionId: string
  projection?: SessionProjection
}

// ============================================================================
// WorkspaceSessionsSubscription
// ============================================================================

export class WorkspaceSessionsSubscription {
  readonly workspaceKey: string
  private lastSeq = 0
  private status: SubscriptionStatus = 'idle'
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  /** WS 事件退订函数 */
  private unlisteners: Array<() => void> = []
  /** 应用增量到桶的回调（默认直接写 workspaceSessionSlice） */
  private onSnapshot: (snapshot: WorkspaceSessionsSnapshot) => void
  private onDelta: (delta: SessionProjection[]) => void
  /** 桶投影移除回调（removed 事件触发，默认 unregisterSession） */
  private onRemoved: (sessionId: string) => void

  constructor(workspaceKey: string, opts?: {
    onSnapshot?: (snapshot: WorkspaceSessionsSnapshot) => void
    onDelta?: (delta: SessionProjection[]) => void
    onRemoved?: (sessionId: string) => void
  }) {
    this.workspaceKey = workspaceKey
    this.onSnapshot = opts?.onSnapshot ?? this.defaultApplySnapshot
    this.onDelta = opts?.onDelta ?? this.defaultApplyDelta
    this.onRemoved = opts?.onRemoved ?? this.defaultApplyRemoved
  }

  /**
   * 启动订阅：
   * 1) 订阅 WS 事件（session-index-upserted/removed）
   * 2) 首拉全量快照写入桶
   * 3) 进入增量轮询兜底（list_after）
   */
  async start(): Promise<void> {
    if (this.disposed) return
    this.setStatus('connecting')
    try {
      // 先订阅 WS 事件，再首拉快照；事件与快照之间以 seq 保证顺序（transport 层去重）。
      await this.setupEventListeners()
      const snapshot = await listWorkspaceSessions(this.workspaceKey)
      if (this.disposed) return
      this.lastSeq = snapshot.lastSeq
      this.onSnapshot(snapshot)
      this.setStatus('active')
      log.info('start 首拉快照完成', { workspaceKey: this.workspaceKey, count: snapshot.sessions.length, lastSeq: this.lastSeq })
      this.startPolling()
    } catch (e) {
      if (this.disposed) return
      log.warn('start 首拉快照失败，进入 suspended', { workspaceKey: this.workspaceKey, error: String(e) })
      this.setStatus('suspended')
      // suspended 仍尝试重连
      this.startPolling()
    }
  }

  /** 停止订阅（桶失活 / 退订） */
  stop(): void {
    this.disposed = true
    this.teardownEventListeners()
    this.stopPolling()
    this.setStatus('stopped')
    log.info('stop', { workspaceKey: this.workspaceKey })
  }

  /**
   * 手动 resync（断线重连 / gap 过大时调用）：
   * 重新首拉全量快照，覆盖桶内投影。
   */
  async resync(): Promise<void> {
    if (this.disposed) return
    log.info('resync 开始', { workspaceKey: this.workspaceKey, prevLastSeq: this.lastSeq })
    try {
      const snapshot = await listWorkspaceSessions(this.workspaceKey)
      if (this.disposed) return
      this.lastSeq = snapshot.lastSeq
      this.onSnapshot(snapshot)
      this.setStatus('active')
      log.info('resync 完成', { workspaceKey: this.workspaceKey, count: snapshot.sessions.length, lastSeq: this.lastSeq })
    } catch (e) {
      log.warn('resync 失败', { workspaceKey: this.workspaceKey, error: String(e) })
      this.setStatus('suspended')
    }
  }

  getState(): SubscriptionState {
    return {
      workspaceKey: this.workspaceKey,
      status: this.status,
      lastSeq: this.lastSeq,
      connected: this.status === 'active',
    }
  }

  // ==========================================================================
  // 内部：WS 事件
  // ==========================================================================

  /** 订阅 session-index 事件（仅处理本桶；退订函数存起来供 stop 清理） */
  private async setupEventListeners(): Promise<void> {
    if (this.disposed) return

    const onUpserted = (payload: unknown): void => {
      const evt = payload as SessionIndexEvent
      if (!evt || evt.workspaceKey !== this.workspaceKey || !evt.projection) return
      if (this.disposed) return
      this.lastSeq = Math.max(this.lastSeq, evt.projection.seq)
      this.onDelta([evt.projection])
    }

    const onRemoved = (payload: unknown): void => {
      const evt = payload as SessionIndexEvent
      if (!evt || evt.workspaceKey !== this.workspaceKey || !evt.sessionId) return
      if (this.disposed) return
      // 远端删除：只移除桶投影，不销毁本地 store（本地 store 由本端 deleteSession 自管）。
      this.onRemoved(evt.sessionId)
    }

    const un1 = await listen(EVENT_UPSERTED, onUpserted)
    const un2 = await listen(EVENT_REMOVED, onRemoved)
    this.unlisteners = [un1, un2]
  }

  private teardownEventListeners(): void {
    for (const un of this.unlisteners) {
      try { un() } catch (e) { log.warn('退订 session-index 事件失败', { error: String(e) }) }
    }
    this.unlisteners = []
  }

  // ==========================================================================
  // 内部：轮询
  // ==========================================================================

  private startPolling(): void {
    this.stopPolling()
    this.timer = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS)
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 单次增量轮询兜底：list_after(lastSeq) → 应用增量；gap 过大 → resync */
  private async pollOnce(): Promise<void> {
    if (this.disposed || this.status === 'stopped') return
    try {
      const delta = await listWorkspaceSessionsAfter(this.workspaceKey, this.lastSeq)
      if (this.disposed) return

      if (delta.length === 0) return

      // gap 检测：增量帧数超阈值 → 回退全量快照
      if (delta.length > GAP_THRESHOLD) {
        log.warn('增量帧超阈值，回退全量快照', { workspaceKey: this.workspaceKey, deltaCount: delta.length, threshold: GAP_THRESHOLD })
        await this.resync()
        return
      }

      this.onDelta(delta)
      // 更新 lastSeq（delta 按 seq 升序，取最后一条）
      const maxSeq = delta[delta.length - 1]?.seq ?? this.lastSeq
      this.lastSeq = Math.max(this.lastSeq, maxSeq)

      if (this.status !== 'active') {
        this.setStatus('active')
      }
    } catch (e) {
      log.warn('增量轮询失败', { workspaceKey: this.workspaceKey, error: String(e) })
      this.setStatus('suspended')
    }
  }

  // ==========================================================================
  // 默认：应用快照/增量/移除到 workspaceSessionSlice
  // ==========================================================================

  private defaultApplySnapshot = (snapshot: WorkspaceSessionsSnapshot): void => {
    const slice = workspaceSessionSlice.getState()
    slice.ensureBucket(this.workspaceKey)
    // 以快照为权威：先清理「不在快照且本端未打开」的残留投影
    // （后端表可能被其他端删除/重建，旧投影滞留会污染远端列表）
    const keepIds = new Set(snapshot.sessions.map((s) => s.sessionId))
    for (const id of sessionStoreManager.getState().stores.keys()) {
      keepIds.add(id)
    }
    // 本端视口 multiSessionIds（本窗口打开过的历史会话）视为本地权威，不清理
    for (const id of useViewStore.getState().multiSessionIds) {
      keepIds.add(id)
    }
    slice.reconcileBucketProjection(this.workspaceKey, keepIds)
    // 再由快照覆盖/合并投影
    for (const proj of snapshot.sessions) {
      slice.upsertSessionProjection(this.workspaceKey, proj.sessionId, {
        title: proj.title,
        status: proj.status as SessionMetadataStatus,
        engineId: proj.engineId,
        workspaceId: proj.workspaceId ?? null,
        conversationId: proj.conversationId,
        updatedAt: new Date(proj.updatedAt).toISOString(),
      } as any)
    }
  }

  private defaultApplyDelta = (delta: SessionProjection[]): void => {
    const slice = workspaceSessionSlice.getState()
    const bucket = slice.getBucket(this.workspaceKey)
    if (!bucket) {
      slice.ensureBucket(this.workspaceKey)
    }
    for (const proj of delta) {
      slice.upsertSessionProjection(this.workspaceKey, proj.sessionId, {
        title: proj.title,
        status: proj.status as SessionMetadataStatus,
        engineId: proj.engineId,
        workspaceId: proj.workspaceId ?? null,
        conversationId: proj.conversationId,
        updatedAt: new Date(proj.updatedAt).toISOString(),
      } as any)
    }
  }

  /** 远端删除：从桶移除投影（不销毁本地 store，本地 store 由本端 deleteSession 自管） */
  private defaultApplyRemoved = (sessionId: string): void => {
    const slice = workspaceSessionSlice.getState()
    slice.unregisterSession(this.workspaceKey, sessionId)
    log.info('远端删除会话投影', { workspaceKey: this.workspaceKey, sessionId })
  }

  private setStatus(status: SubscriptionStatus): void {
    this.status = status
  }
}

type SessionMetadataStatus = 'idle' | 'running' | 'error' | 'none' | string
