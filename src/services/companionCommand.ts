/**
 * 心灵伙伴 /here 命令处理
 *
 * 用户输入 `/here` 触发，调用后端 companion_here 命令获取伙伴回应，
 * 并将回应注入到当前会话作为一条 AI 消息。
 */

import { invoke } from '@/services/transport'
import { sessionStoreManager } from '@/stores/conversationStore'
import { useToastStore } from '@/stores/toastStore'
import { createLogger } from '@/utils/logger'
import i18n from 'i18next'

const log = createLogger('CompanionHere')

/** 检查当前会话是否处于"正在流式输出"的活跃状态 */
function isSessionStreaming(sessionId: string): boolean {
  try {
    const store = sessionStoreManager.getState().stores.get(sessionId)
    return store?.getState().isStreaming ?? false
  } catch {
    return false
  }
}

/** 将伙伴回应作为一条 assistant 消息注入到当前会话 */
function injectCompanionMessage(sessionId: string, message: string): void {
  const store = sessionStoreManager.getState().stores.get(sessionId)
  if (!store) {
    log.warn('/here 注入失败：会话未找到', { sessionId })
    return
  }

  // 构造一条 assistant 消息（复用 ConversationStore 的 addMessage API）
  store.getState().addMessage({
    id: crypto.randomUUID ? crypto.randomUUID() : `companion-${Date.now()}`,
    type: 'assistant',
    engineId: 'simple-ai' as any,
    content: message,
    blocks: [{ type: 'text', content: message }],
    isStreaming: false,
  })

  log.info('/here 伙伴回应已注入', { sessionId, length: message.length })
}

/**
 * 处理 `/here` 命令
 *
 * - 调用后端 companion_here 获取伙伴回应
 * - 注入到当前会话
 * - 返回 true 表示已处理（不继续发送）
 * - 返回 false 表示未处理（应走正常发送）
 */
export async function handleHereCommand(sessionId: string): Promise<boolean> {
  if (!sessionId) {
    log.warn('/here 无活跃会话')
    return false
  }

  const sessionActive = isSessionStreaming(sessionId)
  const toast = useToastStore.getState()

  try {
    const message = await invoke<string>('companion_here', {
      sessionActive,
    })

    if (!message || message.trim().length === 0) {
      toast.info(
        i18n.t('chat:companion.noResponse', '💜'),
        i18n.t('chat:companion.noResponseDesc', '伙伴现在没什么想说的，下次见')
      )
      return true
    }

    injectCompanionMessage(sessionId, message)
    return true
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log.error('/here 失败', error)
    toast.error(
      i18n.t('chat:companion.error', '💜'),
      i18n.t('chat:companion.errorDesc', { defaultValue: '伙伴暂时不可用：{{error}}', error })
    )
    return true
  }
}