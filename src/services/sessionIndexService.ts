/**
 * Session Index Service（S3 · 对接 S1 后端 session_index_* 命令）
 *
 * 封装 workspace 级会话投影的拉取式 API：
 * - listWorkspaceSessions：首拉全量快照 + lastSeq
 * - listWorkspaceSessionsAfter：增量拉取（afterSeq 之后的变更）
 * - registerSessionToIndex：注册会话到投影（新建会话时调用）
 * - deleteSessionFromIndex：从投影删除
 *
 * 传输层：invoke 统一入口
 *   - Tauri 模式：直接 IPC → session_index_* tauri command
 *   - HTTP 模式：POST /api/session-index-* → ipc bridge dispatcher
 *
 * 对齐 spec S3 §3.1：首拉快照 + 增量查询（拉取版，广播帧留后续）。
 */

import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'

const log = createLogger('SessionIndexService')

// ============================================================================
// 类型（对齐后端 SessionProjection，serde camelCase）
// ============================================================================

export interface SessionProjection {
  workspaceKey: string
  sessionId: string
  conversationId?: string
  title: string
  status: 'idle' | 'running' | 'error' | 'none'
  seq: number
  updatedAt: number
  engineId: string
  workspaceId?: string
  lastError?: string
  startedByDevice?: string
  createdAt: number
}

export interface WorkspaceSessionsSnapshot {
  sessions: SessionProjection[]
  lastSeq: number
}

// ============================================================================
// API
// ============================================================================

/**
 * 读取某 workspace 的全量投影快照（附带当前最大 seq，供增量订阅起点）。
 */
export async function listWorkspaceSessions(
  workspaceKey: string,
): Promise<WorkspaceSessionsSnapshot> {
  const result = await invoke<{ sessions: SessionProjection[]; lastSeq: number }>(
    'session_index_list',
    { workspaceKey },
  )
  return { sessions: result.sessions ?? [], lastSeq: result.lastSeq ?? 0 }
}

/**
 * 读取某 workspace 在 afterSeq 之后的投影增量（gap repair / 轮询数据源）。
 */
export async function listWorkspaceSessionsAfter(
  workspaceKey: string,
  afterSeq: number,
): Promise<SessionProjection[]> {
  const result = await invoke<{ sessions: SessionProjection[] }>(
    'session_index_list_after',
    { workspaceKey, afterSeq },
  )
  return result.sessions ?? []
}

/**
 * 注册（upsert）一个会话到投影。幂等；返回写入后的投影条目。
 * 这是「新建会话 → 前端同步投影」的入口。
 */
export async function registerSessionToIndex(
  workspaceKey: string,
  record: {
    id: string
    title: string
    conversationId?: string
    engineId: string
    workspaceId?: string
    createdAt: number
  },
): Promise<SessionProjection> {
  return invoke<SessionProjection>('session_index_register', {
    workspaceKey,
    record,
  })
}

/**
 * 从投影删除条目（幂等；不删 session_records，仅从 workspace 列表移除）。
 */
export async function deleteSessionFromIndex(
  workspaceKey: string,
  sessionId: string,
): Promise<void> {
  await invoke('session_index_delete', { workspaceKey, sessionId })
}

// ============================================================================
// 便捷工具
// ============================================================================

/**
 * 拉取某 workspace 的全量快照，按 sessionId 建立索引 Map。
 * 供桶初始化 / resync 使用。
 */
export async function fetchSessionsMap(
  workspaceKey: string,
): Promise<{ map: Map<string, SessionProjection>; lastSeq: number }> {
  const { sessions, lastSeq } = await listWorkspaceSessions(workspaceKey)
  const map = new Map<string, SessionProjection>()
  for (const s of sessions) {
    map.set(s.sessionId, s)
  }
  log.debug('fetchSessionsMap', { workspaceKey, count: sessions.length, lastSeq })
  return { map, lastSeq }
}
