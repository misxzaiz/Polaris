/**
 * V2SessionEventLog — 阶段 2：后端事件日志（append-only）
 *
 * 实现 `SessionEventLog` + `StateArbiter`（部分），所有读写走后端命令：
 * `session_event_append` / `session_event_read` / `session_event_read_after_seq` /
 * `session_event_current_seq` / `session_event_delete_by_conversation` /
 * `session_get_status` / `session_request_start` / `session_request_interrupt`
 * （`session_reconcile` → 见 reconcile.ts 的 V2 用法）。
 *
 * 与 InMemorySessionEventLog 语义完全一致（幂等 append、seq 升序、状态从日志计算），
 * 区别仅在持久化层：后端 SQLite（`<DataRoot>/session-v2/messages.db`），跨设备共享。
 *
 * 通过统一 transport `invoke` 调用：Tauri 模式 IPC、HTTP 模式 Web API 桥。
 */

import { invoke } from '@/services/transport'
import type {
  SessionEventEntry,
  SessionEventLog,
  SessionStatus,
  StateArbiter,
} from './types'

/** 后端命令名（与 src-tauri commands/session_state_commands.rs + web/api/ipc.rs 对齐） */
const CMD = {
  append: 'session_event_append',
  read: 'session_event_read',
  readAfterSeq: 'session_event_read_after_seq',
  currentSeq: 'session_event_current_seq',
  deleteByConversation: 'session_event_delete_by_conversation',
  getStatus: 'session_get_status',
  requestStart: 'session_request_start',
  requestInterrupt: 'session_request_interrupt',
  // 注册表（Session Registry）
  register: 'session_register',
  get: 'session_get',
  list: 'session_list',
  updateMetadata: 'session_update_metadata',
  appendMessageId: 'session_append_message',
  delete: 'session_delete',
} as const

/**
 * 后端 SQLite 事件日志实现（SessionEventLog 接口）
 *
 * 设计：
 * - 无本地缓存（每次操作直接走后端）——后端权威路径；性能优化留到 V2SessionKernel。
 * - 幂等语义由后端 INSERT OR IGNORE 保证（同 id 重复追加跳过）。
 */
export class V2SessionEventLog implements SessionEventLog {
  /** 本地缓存的最大 seq（仅本进程内 append/read 更新；跨设备权威值走后端） */
  private localMaxSeq = 0

  async append(event: SessionEventEntry): Promise<boolean> {
    const ok = await invoke<boolean>(CMD.append, { ...event })
    if (ok && event.seq > this.localMaxSeq) this.localMaxSeq = event.seq
    return ok
  }

  async read(conversationId: string): Promise<SessionEventEntry[]> {
    const events = await invoke<SessionEventEntry[]>(CMD.read, { conversationId })
    for (const e of events) {
      if (e.seq > this.localMaxSeq) this.localMaxSeq = e.seq
    }
    return events
  }

  async readAfterSeq(seq: number): Promise<SessionEventEntry[]> {
    const events = await invoke<SessionEventEntry[]>(CMD.readAfterSeq, { seq })
    for (const e of events) {
      if (e.seq > this.localMaxSeq) this.localMaxSeq = e.seq
    }
    return events
  }

  currentSeq(): number {
    // 同步签名限制：返回本地缓存（本进程已见的最大 seq）。
    // 跨设备权威当前 seq 由后端 `session_event_current_seq` 命令提供（异步）。
    return this.localMaxSeq
  }

  async deleteByConversation(conversationId: string): Promise<void> {
    await invoke<void>(CMD.deleteByConversation, { conversationId })
  }
}

/**
 * 后端状态仲裁器实现（StateArbiter 接口）
 *
 * 状态从后端事件日志计算（`session_get_status`），不存储前端状态值。
 */
export class V2StateArbiter implements StateArbiter {
  async getStatus(conversationId: string): Promise<SessionStatus> {
    const status = await invoke<SessionStatus>(CMD.getStatus, { conversationId })
    return {
      conversationId: status.conversationId,
      running: status.running,
      lastEventSeq: status.lastEventSeq,
      error: status.error,
      startedAt: status.startedAt,
      endedAt: status.endedAt,
      startedByDevice: status.startedByDevice,
    }
  }

  async requestStart(
    conversationId: string,
    deviceId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    return invoke<{ ok: boolean; reason?: string }>(CMD.requestStart, { conversationId, deviceId })
  }

  async requestInterrupt(
    conversationId: string,
    deviceId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    return invoke<{ ok: boolean; reason?: string }>(CMD.requestInterrupt, {
      conversationId,
      deviceId,
    })
  }
}
