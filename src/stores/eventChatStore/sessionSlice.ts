/**
 * 会话状态 Slice
 *
 * 负责会话 ID、流式状态、错误和进度消息管理
 */

import type { SessionSlice } from './types'

/**
 * 创建会话状态 Slice
 */
export const createSessionSlice: SessionSlice = (set, get) => ({
  // ===== 状态 =====
  conversationId: null,
  currentConversationSeed: null,
  isStreaming: false,
  error: null,
  progressMessage: null,
  providerSessionCache: null,

  // ===== 方法 =====

  setConversationId: (id) => {
    const { providerSessionCache, conversationId: currentId } = get()

    // 如果切换到不同的对话，清理 Provider Session
    if (providerSessionCache && currentId !== id) {
      console.log('[EventChatStore] 切换对话，清理 Provider session')
      try {
        providerSessionCache.session.dispose()
      } catch (e) {
        console.warn('[EventChatStore] 清理 Session 失败:', e)
      }

      set({
        conversationId: id,
        currentConversationSeed: null,
        providerSessionCache: null
      })
    } else {
      set({ conversationId: id })
    }
  },

  setStreaming: (streaming) => {
    set({ isStreaming: streaming })
  },

  setError: (error) => {
    set({ error })
  },

  setProgressMessage: (message) => {
    set({ progressMessage: message })
  },
})
