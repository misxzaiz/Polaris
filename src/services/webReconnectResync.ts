/**
 * Web 模式断线重连兜底恢复
 *
 * 场景：手机浏览器锁屏/切后台导致 WebSocket 长时间断开，重连后服务端
 * 重放缓冲已无法完整覆盖断线窗口（resume-gap），流式输出的增量事件
 * 永久丢失。此时对仍处于流式状态的会话执行全量恢复：
 *
 * 1. 查询后端会话进程是否仍在运行（is_chat_session_running）；
 * 2. 重新拉取引擎落盘的会话历史（Claude Code / Codex JSONL），
 *    覆盖本地消息，补回断线期间丢失的内容；
 * 3. 按后端真实状态恢复 isStreaming —— 仍在运行则继续接收后续
 *    实时事件，已结束则正常收尾（避免转圈卡死）。
 *
 * 触发方：transport 层收到 resume-complete { gap: true } 时调用。
 */

import type { ChatMessage, EngineId } from '@/types'
import type { ConversationStoreInstance } from '@/stores/conversationStore/types'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { normalizeEngineId } from '@/utils/engineDisplay'
import { createLogger } from '@/utils/logger'
import { getClaudeCodeHistoryService } from './claudeCodeHistoryService'
import { getCodexHistoryService } from './codexHistoryService'
import { currentMode, invoke, manualReconnect } from './transport'

const log = createLogger('WebReconnectResync')

/** 防止 resume-gap 在短时间内重复触发并发恢复 */
let resyncInFlight = false

/**
 * 对所有「本地认为仍在流式输出」的会话执行全量恢复。
 * 幂等：并发触发时仅执行一次。
 */
export async function resyncAfterResumeGap(): Promise<void> {
  if (resyncInFlight) {
    log.info('恢复已在进行中，跳过重复触发')
    return
  }
  resyncInFlight = true

  try {
    const manager = sessionStoreManager.getState()
    const jobs: Promise<void>[] = []

    for (const [sessionId, store] of manager.stores) {
      const state = store.getState()
      if (!state.conversationId || !state.isStreaming) continue

      const engineId = normalizeEngineId(manager.sessionMetadata.get(sessionId)?.engineId)
      jobs.push(resyncSession(sessionId, store, state.conversationId, engineId))
    }

    if (jobs.length === 0) {
      log.info('无流式中的会话需要恢复')
      return
    }

    log.info(`检测到事件缺口，开始恢复 ${jobs.length} 个流式会话`)
    await Promise.allSettled(jobs)
  } finally {
    resyncInFlight = false
  }
}

/**
 * 手动「同步恢复」：用户主动触发的全量恢复（状态栏刷新按钮）。
 *
 * 与自动 gap 兜底的区别：**无条件**作用于当前活跃会话——不依赖
 * isStreaming 标记（页面被浏览器丢弃重载后该标记必然丢失），覆盖：
 * 页面重载、事件缺口、半开连接、状态错乱等一切残局。
 *
 * 流程：重连 WS（含 resume 补发）→ 重拉落盘历史 → 重注册
 * conversationId 反向索引（让后端续传事件路由回本会话）→ 校正流式状态。
 *
 * @returns false 表示当前会话没有可恢复的后端 conversationId
 */
export async function manualRefreshActiveSession(): Promise<boolean> {
  // 1. 先确保 WS 连接（重连成功后 transport 层会自动发起 seq resume）
  if (currentMode === 'http') {
    try {
      await manualReconnect()
    } catch (e) {
      log.warn('WS 重连失败，仍尝试通过 HTTP 恢复历史', { error: String(e) })
    }
  }

  const manager = sessionStoreManager.getState()
  const activeSessionId = manager.activeSessionId
  if (!activeSessionId) {
    log.info('无活跃会话，跳过手动恢复')
    return false
  }
  const store = manager.stores.get(activeSessionId)
  if (!store) return false

  const conversationId = store.getState().conversationId
  if (!conversationId) {
    log.info('活跃会话无 conversationId，无需恢复', { activeSessionId })
    return false
  }

  const engineId = normalizeEngineId(manager.sessionMetadata.get(activeSessionId)?.engineId)
  log.info('手动恢复开始', { activeSessionId, conversationId, engineId })

  // 2. 重注册反向索引：后端续传事件携带的是旧前端 sessionId（contextId），
  //    dispatchEvent 的反向索引兜底依赖此映射将事件续接到本会话。
  manager.registerConversationId(conversationId, activeSessionId)

  // 3. 重拉历史 + 校正流式状态
  await resyncSession(activeSessionId, store, conversationId, engineId)
  return true
}

/** 恢复单个会话：查询存活 → 重拉历史 → 校正流式状态 */async function resyncSession(
  sessionId: string,
  store: ConversationStoreInstance,
  conversationId: string,
  engineId: EngineId,
): Promise<void> {
  // 1. 查询后端会话进程是否仍在运行
  let running = false
  try {
    const res = await invoke<{ running: boolean }>('is_chat_session_running', {
      sessionId: conversationId,
    })
    running = !!res?.running
  } catch (e) {
    log.warn(`查询会话存活状态失败，假定已结束: ${conversationId}`, { error: String(e) })
  }

  // 2. 重新拉取引擎落盘历史，覆盖本地消息（补回断线丢失内容）
  try {
    const messages = await loadHistoryMessages(conversationId, engineId)
    if (messages.length > 0) {
      store.getState().setMessagesFromHistory(messages, conversationId)
      log.info('会话历史已重载', { sessionId, conversationId, messageCount: messages.length })
    } else {
      log.warn('历史为空，保留现有消息', { sessionId, conversationId, engineId })
    }
  } catch (e) {
    log.error(
      `重载会话历史失败: ${conversationId}`,
      e instanceof Error ? e : new Error(String(e)),
    )
  }

  // 3. 校正流式状态：仍在运行 → 继续接收实时事件；已结束 → 正常收尾
  //    （setMessagesFromHistory 已将 isStreaming 置 false，仅运行中需要恢复）
  if (running) {
    store.getState().setStreaming(true)
  } else {
    store.getState().setStreaming(false)
    store.getState().setProgressMessage(null)
  }
  log.info('会话流式状态已校正', { sessionId, running })
}

/** 按引擎拉取并转换落盘历史；不支持落盘历史的引擎返回空数组 */
async function loadHistoryMessages(
  conversationId: string,
  engineId: EngineId,
): Promise<ChatMessage[]> {
  if (engineId === 'codex') {
    const svc = getCodexHistoryService()
    const history = await svc.getSessionHistory(conversationId)
    return history.length > 0 ? svc.convertToChatMessages(history) : []
  }
  if (engineId === 'claude-code') {
    const svc = getClaudeCodeHistoryService()
    const history = await svc.getSessionHistory(conversationId)
    return history.length > 0 ? svc.convertToChatMessages(history) : []
  }
  // 其他引擎（openai-protocol / simple-ai 等）无引擎侧落盘历史，
  // 仅校正流式状态，不重载消息。
  return []
}
