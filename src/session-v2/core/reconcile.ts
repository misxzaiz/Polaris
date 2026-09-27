/**
 * 对账（Reconcile）— 验证用实现
 *
 * 比对前端快照与后端日志，找出差异。
 * 借鉴银行对账：日志即真相，前端只是缓存，差异触发修复。
 */

import type {
  MessageEntry,
  MessageLogStorage,
  SessionEventLog,
  SessionStatus,
  ReconcileResult,
} from './types'

/**
 * 执行对账
 *
 * @param messageLog 后端消息日志
 * @param eventLog 后端事件日志（用于状态计算）
 * @param arbiter 状态仲裁器
 * @param conversationId 会话 ID
 * @param clientMessages 前端当前持有的消息列表（快照）
 * @param clientRunning 前端认为的 running 状态
 * @returns 对账结果
 */
export async function reconcile(
  messageLog: MessageLogStorage,
  _eventLog: SessionEventLog,
  arbiter: { getStatus(conversationId: string): Promise<SessionStatus> },
  conversationId: string,
  clientMessages: MessageEntry[],
  clientRunning: boolean,
): Promise<ReconcileResult> {
  // 1. 拉取后端完整消息列表
  const serverMessages = await messageLog.read(conversationId)

  // 2. 计算 diff
  const serverIds = new Set(serverMessages.map(m => m.id))
  const clientIds = new Set(clientMessages.map(m => m.id))

  const missing: MessageEntry[] = serverMessages.filter(m => !clientIds.has(m.id))

  const extra: MessageEntry[] = clientMessages.filter(m => !serverIds.has(m.id))

  // 3. 比对状态
  const serverStatus = await arbiter.getStatus(conversationId)
  const statusMismatch = clientRunning !== serverStatus.running

  return {
    missing,
    extra,
    statusMismatch,
    serverStatus,
  }
}
