/**
 * 聊天会话上下文（v2 交互组件）
 *
 * SessionMessagesView 在渲染树根部下发当前 sessionId；PluginCardHost 兜底消费——
 * 块自身缺 sessionId（历史恢复的旧块/跨版本块）时，回执回流仍能路由到正确会话
 * （formHostRegistration.enqueueComponentReceipt 的 key）。
 */

import { createContext, useContext } from 'react'

export const ChatSessionContext = createContext<string | null>(null)

/** 取当前渲染树归属的会话 id（非会话树内渲染返回 null） */
export function useChatSessionId(): string | null {
  return useContext(ChatSessionContext)
}
