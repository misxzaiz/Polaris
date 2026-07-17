/**
 * 助手消息文本提取工具
 *
 * 从会话状态中提取最新一条助手消息的纯文本，供"结果回流"类场景使用
 * （提交信息生成回流条、提示词优化回填等）。
 * 自 commitMessageChat 抽出共享。
 */

import { isTextBlock } from '@/types/chat'
import type { AssistantChatMessage } from '@/types/chat'
import type { ConversationState } from '@/stores/conversationStore/types'

/**
 * 从助手消息中提取纯文本（拼接所有 text block）。
 */
export function extractAssistantText(message: AssistantChatMessage | null | undefined): string {
  if (!message) return ''
  if (message.content) return message.content
  return message.blocks
    .filter(isTextBlock)
    .map((b) => (b as { content: string }).content)
    .join('')
}

/**
 * 找出最新一条助手消息的文本。
 *
 * 流式中的 currentMessage 优先于已归档 messages 的末条 assistant，
 * 这样流式过程中调用方能实时跟随最新输出。
 */
export function pickLatestAssistantText(state: ConversationState): string {
  if (state.currentMessage) {
    const text = extractAssistantText({
      id: state.currentMessage.id,
      type: 'assistant',
      engineId: state.currentMessage.engineId,
      blocks: state.currentMessage.blocks,
      isStreaming: true,
      timestamp: new Date().toISOString(),
    } as AssistantChatMessage)
    if (text) return text
  }

  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (msg.type === 'assistant') {
      const text = extractAssistantText(msg as AssistantChatMessage)
      if (text) return text
    }
  }
  return ''
}
