/**
 * cap.session 统一调用助手（ai-chat-plugin-extraction-spec P1.1）
 *
 * 会话读面收口：权威运行状态 / 会话注册表 / 消息库读取 / workspace 投影。
 * 写面在 cap.ai.chat（见 aiChatDispatch.ts）——本模块只读，不新增写路径。
 *
 * 消费方：
 * - 宿主 chrome 的 sessionDirectory 薄 store（P3：SessionTabs/通知/QuickSwitch 改接）；
 * - chat-desk 插件（经 __POLARIS_HOST_INVOKE__ router_dispatch 同款协议）。
 */
import { invoke } from '@/services/transport'
// AiDispatchResponse（对齐 src-tauri ai_chat_dispatch 返回；原 aiChatDispatch.ts
// 随对话域迁入插件，宿主 chrome 只需此只读面的类型）
interface AiDispatchResponse {
  msgId: string
  ok: boolean
  result: unknown
  error: string | null
  trace: string
}

const TARGET = 'cap.session'

/** SessionStatus（对齐 src-tauri services/session_state.rs，camelCase 透传） */
export interface SessionStatus {
  conversationId: string
  running: boolean
  lastEventSeq: number
  error?: string | null
  startedAt?: number | null
  endedAt?: number | null
  startedByDevice?: string | null
}

/** SessionProjection（workspace 级权威投影条目） */
export interface SessionProjection {
  workspaceKey: string
  sessionId: string
  conversationId?: string
  title: string
  status: 'idle' | 'running' | 'error' | 'none' | string
  seq: number
  updatedAt: number
  engineId: string
  workspaceId?: string
  lastError?: string
  startedByDevice?: string
  createdAt: number
}

/** MessageEntry（对齐 session-v2/core/types.ts） */
export interface SessionMessageEntry {
  id: string
  conversationId: string
  role: string
  timestamp: number
  deviceId: string
  content: Record<string, unknown>
  version: number
  parentVersion?: number
}

/** ReconcileResult（对齐 session_state.rs） */
export interface ReconcileResult {
  missing: SessionMessageEntry[]
  extra: SessionMessageEntry[]
  statusMismatch: boolean
  serverStatus: SessionStatus
}

async function sessionDispatch<T>(payload: Record<string, unknown>): Promise<T> {
  const res = await invoke<AiDispatchResponse>('router_dispatch', {
    req: { target: TARGET, payload },
  })
  if (!res.ok) {
    throw new Error(res.error || ('cap.session ' + String(payload.action ?? '') + ' 失败'))
  }
  return res.result as T
}

/** 权威运行状态（等价 session_get_status；从后端事件日志计算） */
export function getSessionStatus(conversationId: string): Promise<SessionStatus> {
  return sessionDispatch<SessionStatus>({ action: 'state.get', conversationId })
}

/** 会话注册表全量（Session Registry） */
export function listSessionRecords<T = unknown>(): Promise<T[]> {
  return sessionDispatch<T[]>({ action: 'state.list' })
}

/** 对账：前端快照 ↔ 后端日志 */
export function reconcileSession(
  conversationId: string,
  clientMessages: SessionMessageEntry[],
  clientRunning: boolean,
): Promise<ReconcileResult> {
  return sessionDispatch<ReconcileResult>({
    action: 'state.reconcile',
    conversationId,
    clientMessages,
    clientRunning,
  })
}

/** 后端消息库权威读取（QuickSwitchPanel 全量导出等价替代） */
export function readSessionMessages(
  conversationId: string,
  afterTimestamp?: number | null,
  limit?: number | null,
): Promise<SessionMessageEntry[]> {
  return sessionDispatch<SessionMessageEntry[]>({
    action: 'message.read',
    conversationId,
    afterTimestamp: afterTimestamp ?? null,
    limit: limit ?? null,
  })
}

/** 含历史版本的消息读取 */
export function readSessionMessageHistory(id: string): Promise<SessionMessageEntry[]> {
  return sessionDispatch<SessionMessageEntry[]>({ action: 'message.read_history', id })
}

/** workspace 投影快照（附当前最大 seq，供订阅/轮询起点） */
export function listSessionIndex(
  workspaceKey: string,
): Promise<{ sessions: SessionProjection[]; currentSeq: number }> {
  return sessionDispatch<{ sessions: SessionProjection[]; currentSeq: number }>({
    action: 'index.list',
    workspaceKey,
  })
}

/** workspace 投影增量（gap repair / 订阅数据源） */
export function listSessionIndexAfter(
  workspaceKey: string,
  afterSeq: number,
): Promise<SessionProjection[]> {
  return sessionDispatch<SessionProjection[]>({
    action: 'index.list_after',
    workspaceKey,
    afterSeq,
  })
}
