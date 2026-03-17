/**
 * 历史管理 Slice
 *
 * 负责存储持久化、历史会话管理和归档操作
 */

import type { HistorySlice, HistoryEntry, UnifiedHistoryItem } from './types'
import { MAX_MESSAGES, STORAGE_KEY, STORAGE_VERSION, SESSION_HISTORY_KEY, MAX_SESSION_HISTORY } from './types'
import { useToolPanelStore } from '../toolPanelStore'
import { useConfigStore } from '../configStore'

/**
 * 创建历史管理 Slice
 */
export const createHistorySlice: HistorySlice = (set, get) => ({
  // ===== 状态 =====
  isArchiveExpanded: false,
  maxMessages: MAX_MESSAGES,
  isInitialized: false,
  isLoadingHistory: false,

  // ===== 方法 =====

  setMaxMessages: (max) => {
    set({ maxMessages: Math.max(100, max) })

    const { messages, archivedMessages } = get()
    if (messages.length > max) {
      const archiveCount = messages.length - max
      const toArchive = messages.slice(0, archiveCount)
      const remaining = messages.slice(archiveCount)

      set({
        messages: remaining,
        archivedMessages: [...toArchive, ...archivedMessages] as any[],
      })
    }
  },

  toggleArchive: () => {
    set((state) => ({
      isArchiveExpanded: !state.isArchiveExpanded,
    }))
  },

  loadArchivedMessages: () => {
    const { archivedMessages } = get()
    if (archivedMessages.length === 0) return

    set({
      messages: [...archivedMessages, ...get().messages],
      archivedMessages: [],
      isArchiveExpanded: false,
    })
  },

  loadMoreArchivedMessages: (count = 20) => {
    const { archivedMessages, messages } = get()
    if (archivedMessages.length === 0) return

    // 从归档末尾取 count 条消息（最新的归档消息）
    const loadCount = Math.min(count, archivedMessages.length)
    const toLoad = archivedMessages.slice(-loadCount)
    const remaining = archivedMessages.slice(0, -loadCount)

    console.log(`[EventChatStore] 分批加载 ${loadCount} 条消息，剩余 ${remaining.length} 条归档`)

    set({
      messages: [...toLoad, ...messages],
      archivedMessages: remaining,
    })

    get().saveToStorage()
  },

  saveToStorage: () => {
    try {
      const state = get()
      const data = {
        version: STORAGE_VERSION,
        timestamp: new Date().toISOString(),
        messages: state.messages,
        archivedMessages: state.archivedMessages,
        conversationId: state.conversationId,
      }
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch (e) {
      console.error('[EventChatStore] 保存状态失败:', e)
    }
  },

  restoreFromStorage: () => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY)
      if (!stored) return false

      const data = JSON.parse(stored)

      if (data.version !== STORAGE_VERSION) {
        console.warn('[EventChatStore] 存储版本不匹配，忽略')
        return false
      }

      const storedTime = new Date(data.timestamp).getTime()
      const now = Date.now()
      if (now - storedTime > 60 * 60 * 1000) {
        sessionStorage.removeItem(STORAGE_KEY)
        return false
      }

      set({
        messages: data.messages || [],
        archivedMessages: data.archivedMessages || [],
        conversationId: data.conversationId || null,
        isStreaming: false,
        isInitialized: true,
        currentMessage: null,
        toolBlockMap: new Map(),
      })

      sessionStorage.removeItem(STORAGE_KEY)
      return true
    } catch (e) {
      console.error('[EventChatStore] 恢复状态失败:', e)
      return false
    }
  },

  saveToHistory: (title) => {
    try {
      const state = get()
      if (!state.conversationId || state.messages.length === 0) return

      // 获取当前引擎 ID
      const config = useConfigStore.getState().config
      const engineId: 'claude-code' | 'iflow' | 'codex' | `provider-${string}` = (config?.defaultEngine || 'claude-code') as any

      // 获取现有历史
      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const history = historyJson ? JSON.parse(historyJson) : []

      // 生成标题（从第一条用户消息提取）
      const firstUserMessage = state.messages.find(m => m.type === 'user')
      let sessionTitle = title || '新对话'
      if (!title && firstUserMessage && 'content' in firstUserMessage) {
        sessionTitle = (firstUserMessage.content as string).slice(0, 50) + '...'
      }

      // 创建历史记录
      const historyEntry: HistoryEntry = {
        id: state.conversationId,
        title: sessionTitle,
        timestamp: new Date().toISOString(),
        messageCount: state.messages.length,
        engineId,
        data: {
          messages: state.messages,
          archivedMessages: state.archivedMessages,
        }
      }

      // 移除同ID的旧记录
      const filteredHistory = history.filter((h: HistoryEntry) => h.id !== state.conversationId)

      // 添加新记录到开头
      filteredHistory.unshift(historyEntry)

      // 限制历史数量
      const limitedHistory = filteredHistory.slice(0, MAX_SESSION_HISTORY)

      localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(limitedHistory))
      console.log('[EventChatStore] 会话已保存到历史:', sessionTitle, '引擎:', engineId)
    } catch (e) {
      console.error('[EventChatStore] 保存历史失败:', e)
    }
  },

  getUnifiedHistory: async () => {
    const items: UnifiedHistoryItem[] = []

    // 动态导入服务
    const { getIFlowHistoryService } = await import('../../services/iflowHistoryService')
    const { getClaudeCodeHistoryService } = await import('../../services/claudeCodeHistoryService')
    const { useWorkspaceStore } = await import('../workspaceStore')

    const iflowService = getIFlowHistoryService()
    const claudeCodeService = getClaudeCodeHistoryService()
    const workspaceStore = useWorkspaceStore.getState()
    const currentWorkspace = workspaceStore.getCurrentWorkspace()

    try {
      // 1. 获取 localStorage 中的会话历史
      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const localHistory: HistoryEntry[] = historyJson ? JSON.parse(historyJson) : []

      for (const h of localHistory) {
        items.push({
          id: h.id,
          title: h.title,
          timestamp: h.timestamp,
          messageCount: h.messageCount,
          engineId: h.engineId || 'claude-code',
          source: 'local',
        })
      }

      // 2. 获取 Claude Code 原生会话列表
      try {
        const claudeCodeSessions = await claudeCodeService.listSessions(
          currentWorkspace?.path
        )
        for (const session of claudeCodeSessions) {
          if (!items.find(item => item.id === session.sessionId)) {
            items.push({
              id: session.sessionId,
              title: session.firstPrompt || '无标题会话',
              timestamp: session.modified || session.created || new Date().toISOString(),
              messageCount: session.messageCount,
              engineId: 'claude-code',
              source: 'claude-code-native',
              fileSize: session.fileSize,
              projectPath: session.projectPath,
            })
          }
        }
      } catch (e) {
        console.warn('[EventChatStore] 获取 Claude Code 原生会话失败:', e)
      }

      // 3. 获取 IFlow 会话列表
      try {
        const iflowSessions = await iflowService.listSessions()
        for (const session of iflowSessions) {
          if (!items.find(item => item.id === session.sessionId)) {
            items.push({
              id: session.sessionId,
              title: session.title,
              timestamp: session.updatedAt,
              messageCount: session.messageCount,
              engineId: 'iflow',
              source: 'iflow',
              fileSize: session.fileSize,
              inputTokens: session.inputTokens,
              outputTokens: session.outputTokens,
            })
          }
        }
      } catch (e) {
        console.warn('[EventChatStore] 获取 IFlow 会话失败:', e)
      }

      // 4. 获取 Codex 会话列表
      try {
        const { listCodexSessions } = await import('../../services/tauri')
        const codexSessions = await listCodexSessions(currentWorkspace?.path || '')
        for (const session of codexSessions) {
          if (!items.find(item => item.id === session.sessionId)) {
            items.push({
              id: session.sessionId,
              title: session.title,
              timestamp: session.updatedAt,
              messageCount: session.messageCount,
              engineId: 'codex',
              source: 'codex',
              fileSize: session.fileSize,
            })
          }
        }
      } catch (e) {
        console.warn('[EventChatStore] 获取 Codex 会话失败:', e)
      }

      // 5. 按时间戳排序
      items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

      return items
    } catch (e) {
      console.error('[EventChatStore] 获取统一历史失败:', e)
      return []
    }
  },

  restoreFromHistory: async (sessionId, engineId, projectPath) => {
    try {
      set({ isLoadingHistory: true })

      // 动态导入服务
      const { getIFlowHistoryService } = await import('../../services/iflowHistoryService')
      const { getClaudeCodeHistoryService } = await import('../../services/claudeCodeHistoryService')

      // 1. 先尝试从 localStorage 恢复
      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const localHistory = historyJson ? JSON.parse(historyJson) : []
      const localSession = localHistory.find((h: HistoryEntry) => h.id === sessionId)

      if (localSession) {
        set({
          messages: localSession.data.messages || [],
          archivedMessages: localSession.data.archivedMessages || [],
          conversationId: localSession.id,
          isStreaming: false,
          error: null,
        })

        get().saveToStorage()
        console.log('[EventChatStore] 已从本地历史恢复会话:', localSession.title)
        return true
      }

      // 2. 尝试从 Claude Code 原生历史恢复
      if (!engineId || engineId === 'claude-code') {
        const claudeCodeService = getClaudeCodeHistoryService()

        const messages = await claudeCodeService.getSessionHistory(
          sessionId,
          projectPath
        )

        if (messages.length > 0) {
          const chatMessages = claudeCodeService.convertToChatMessages(messages)
          const toolCalls = claudeCodeService.extractToolCalls(messages)

          useToolPanelStore.getState().clearTools()
          for (const tool of toolCalls) {
            useToolPanelStore.getState().addTool(tool)
          }

          set({
            messages: chatMessages,
            archivedMessages: [],
            conversationId: sessionId,
            isStreaming: false,
            error: null,
          })

          console.log('[EventChatStore] 已从 Claude Code 原生历史恢复会话:', sessionId)
          return true
        }
      }

      // 3. 尝试从 IFlow 恢复
      if (!engineId || engineId === 'iflow') {
        const iflowService = getIFlowHistoryService()
        const messages = await iflowService.getSessionHistory(sessionId)

        if (messages.length > 0) {
          const convertedMessages = iflowService.convertMessagesToFormat(messages)
          const toolCalls = iflowService.extractToolCalls(messages)

          useToolPanelStore.getState().clearTools()
          for (const tool of toolCalls) {
            useToolPanelStore.getState().addTool(tool)
          }

          const chatMessages = convertedMessages.map((msg): any => {
            if (msg.role === 'user') {
              return {
                id: msg.id,
                type: 'user',
                content: msg.content,
                timestamp: msg.timestamp,
              }
            } else if (msg.role === 'assistant') {
              return {
                id: msg.id,
                type: 'assistant',
                blocks: [{ type: 'text', content: msg.content }],
                timestamp: msg.timestamp,
                content: msg.content,
                toolSummary: msg.toolSummary,
              }
            } else {
              return {
                id: msg.id,
                type: 'system',
                content: msg.content,
                timestamp: msg.timestamp,
              }
            }
          })

          set({
            messages: chatMessages,
            archivedMessages: [],
            conversationId: sessionId,
            isStreaming: false,
            error: null,
          })

          console.log('[EventChatStore] 已从 IFlow 恢复会话:', sessionId)
          return true
        }
      }

      // 4. 尝试从 Codex 恢复
      if (engineId === 'codex') {
        const { getCodexSessionHistory } = await import('../../services/tauri')
        const messages = await getCodexSessionHistory(sessionId)

        if (messages && messages.length > 0) {
          const chatMessages = messages.map((msg): any => {
            if (msg.type === 'user') {
              return {
                id: msg.id,
                type: 'user',
                content: msg.content,
                timestamp: msg.timestamp,
              }
            } else {
              return {
                id: msg.id,
                type: 'assistant',
                blocks: [{ type: 'text', content: msg.content }],
                timestamp: msg.timestamp,
                content: msg.content,
              }
            }
          })

          set({
            messages: chatMessages,
            archivedMessages: [],
            conversationId: sessionId,
            isStreaming: false,
            error: null,
          })

          console.log('[EventChatStore] 已从 Codex 恢复会话:', sessionId)
          return true
        }
      }

      return false
    } catch (e) {
      console.error('[EventChatStore] 从历史恢复失败:', e)
      return false
    } finally {
      set({ isLoadingHistory: false })
    }
  },

  deleteHistorySession: (sessionId, source) => {
    try {
      if (source === 'iflow' || (!source && sessionId.startsWith('session-'))) {
        console.log('[EventChatStore] IFlow 会话无法删除，仅作忽略:', sessionId)
        return
      }
      if (source === 'codex') {
        console.log('[EventChatStore] Codex 会话无法删除，仅作忽略:', sessionId)
        return
      }

      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const history = historyJson ? JSON.parse(historyJson) : []

      const filteredHistory = history.filter((h: HistoryEntry) => h.id !== sessionId)
      localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(filteredHistory))
    } catch (e) {
      console.error('[EventChatStore] 删除历史会话失败:', e)
    }
  },

  clearHistory: () => {
    try {
      localStorage.removeItem(SESSION_HISTORY_KEY)
      console.log('[EventChatStore] 历史已清空')
    } catch (e) {
      console.error('[EventChatStore] 清空历史失败:', e)
    }
  },
})
