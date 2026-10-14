/**
 * WorkspaceSessionsSubscription（S3 · 拉取版）
 *
 * 对齐 ZCode subscribeSessionsIndexV4 / onDynamicSessionsIndexFrame
 * （首拉快照 + 增量帧 + gap repair + 乐观合并），但用拉取式 API
 * （session_index_list/_after）实现，广播帧留后续（spec §9 决策 2）。
 *
 * 职责：
 * - 桶激活时 start()：首拉快照写入桶 → 进入增量轮询
 * - 增量轮询：定期 list_after(lastSeq) 应用增量
 * - gap repair：seq 跳跃 → 全量快照重拉
 * - 桶失活时 stop()：退订（清定时器），无泄漏
 *
 * 设计约束（spec §6 风险）：
 * - 乐观合并：本端命令的乐观状态与后端帧冲突时，以帧为准
 * - 时序：首拉快照与增量之间用 lastSeq 保证连续性
 * - 不动 eventRouter / V2SessionKernel 轮询（S3 收尾项）
 */

import {
  listWorkspaceSessions,
  listWorkspaceSessionsAfter,
  type SessionProjection,
  type WorkspaceSessionsSnapshot,
} from '@/services/sessionIndexService'
import { workspaceSessionSlice } from '@/stores/workspaceSession'
import { createLogger } from '@/utils/logger'

const log = createLogger('WorkspaceSessionsSubscription')

/** 增量轮询间隔（ms）。对齐 spec：拉取版替代 1s 无差别轮询，只在桶激活时跑。 */
const POLL_INTERVAL_MS = 5_000

/** gap 阈值：增量帧数超过此值认为丢失过多，回退全量快照。 */
const GAP_THRESHOLD = 50

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

// ============================================================================
// WorkspaceSessionsSubscription
// ============================================================================

export class WorkspaceSessionsSubscription {
  readonly workspaceKey: string
  private lastSeq = 0
  private status: SubscriptionStatus = 'idle'
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  /** 应用增量到桶的回调（默认直接写 workspaceSessionSlice） */
  private onSnapshot: (snapshot: WorkspaceSessionsSnapshot) => void
  private onDelta: (delta: SessionProjection[]) => void

  constructor(workspaceKey: string, opts?: {
    onSnapshot?: (snapshot: WorkspaceSessionsSnapshot) => void
    onDelta?: (delta: SessionProjection[]) => void
  }) {
    this.workspaceKey = workspaceKey
    this.onSnapshot = opts?.onSnapshot ?? this.defaultApplySnapshot
    this.onDelta = opts?.onDelta ?? this.defaultApplyDelta
  }

  /**
   * 启动订阅：
   * 1) 首拉全量快照写入桶
   * 2) 进入增量轮询（list_after）
   */
  async start(): Promise<void> {
    if (this.disposed) return
    this.setStatus('connecting')
    try {
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

  /** 单次增量轮询：list_after(lastSeq) → 应用增量；gap 过大 → resync */
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
  // 默认：应用快照/增量到 workspaceSessionSlice
  // ==========================================================================

  private defaultApplySnapshot = (snapshot: WorkspaceSessionsSnapshot): void => {
    const slice = workspaceSessionSlice.getState()
    slice.ensureBucket(this.workspaceKey)
    // 覆盖桶内投影：用快照重建 sessionMetadata
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

  private setStatus(status: SubscriptionStatus): void {
    this.status = status
  }
}

type SessionMetadataStatus = 'idle' | 'running' | 'error' | 'none' | string
