/**
 * 会话状态 Slice
 *
 * 负责会话 ID、流式状态、错误和进度消息管理
 */

import type { SessionSlice } from './types'

/**
 * 创建会话状态 Slice
 */
export const createSessionSlice: SessionSlice = (set) => ({
  // ===== 状态 =====
  conversationId: null,
  currentConversationSeed: null,
  isStreaming: false,
  error: null,
  progressMessage: null,

  // ===== 方法 =====

  setConversationId: (id) => {
    set({
      conversationId: id,
      currentConversationSeed: null,
    })
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
