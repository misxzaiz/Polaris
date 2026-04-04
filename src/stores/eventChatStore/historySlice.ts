/**
 * 历史管理 Slice
 *
 * 负责存储持久化、历史会话管理和归档操作
 *
 * 已使用依赖注入模式解耦外部 Store：
 * - configActions: getConfig
 * - workspaceActions: getCurrentWorkspace
 * - toolPanelActions: clearTools, addTool
 *
 * 持久化说明：
 * - 会话元数据由 zustand persist 中间件自动持久化
 * - 消息数据通过 saveToHistory() 手动保存到历史
 * - saveToStorage/restoreFromStorage 已废弃，保留空实现以兼容
 */

import type { HistorySlice, HistoryEntry, UnifiedHistoryItem } from './types'
import type { ChatMessage, UserChatMessage, AssistantChatMessage, SystemChatMessage, EngineId } from '../../types'
import { createLogger } from '../../utils/logger'
import { useWorkspaceStore } from '../workspaceStore'
import { sessionStoreManager } from '../conversationStore/sessionStoreManager'

const log = createLogger('EventChatStore')
import { MAX_MESSAGES, SESSION_HISTORY_KEY, MAX_SESSION_HISTORY } from './types'
import { getIFlowHistoryService } from '../../services/iflowHistoryService'
import { getClaudeCodeHistoryService } from '../../services/claudeCodeHistoryService'
import { listCodexSessions, getCodexSessionHistory } from '../../services/tauri'

/**
 * 从路径中提取名称
 */
function getPathBasename(pathStr: string): string {
  const normalized = pathStr.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || pathStr
}

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
        archivedMessages: [...toArchive, ...archivedMessages] as ChatMessage[],
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

    log.debug(`分批加载消息`, { loadCount, remaining: remaining.length })

    set({
      messages: [...toLoad, ...messages],
      archivedMessages: remaining,
    })

    // 注意：不再调用 saveToStorage()，由 zustand persist 自动管理
  },

  /**
   * @deprecated 已废弃 - 使用 zustand persist 中间件自动持久化
   * 保留空实现以兼容现有代码
   */
  saveToStorage: () => {
    // 由 zustand persist 中间件自动处理，无需手动保存
    log.debug('saveToStorage 已废弃，由 persist 中间件自动处理')
  },

  /**
   * @deprecated 已废弃 - 使用 zustand persist 中间件自动恢复
   * 保留空实现以兼容现有代码
   */
  restoreFromStorage: () => {
    // 由 zustand persist 中间件自动处理
    log.debug('restoreFromStorage 已废弃，由 persist 中间件自动处理')
    return false
  },

  saveToHistory: (title) => {
    try {
      const state = get()
      if (!state.conversationId || state.messages.length === 0) return

      // 使用依赖注入获取当前引擎 ID
      const configActions = get().getConfigActions()
      const config = configActions?.getConfig()
      const engineId: EngineId = (config?.defaultEngine || 'claude-code') as EngineId

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

    const iflowService = getIFlowHistoryService()
    const claudeCodeService = getClaudeCodeHistoryService()
    // 使用依赖注入获取当前工作区
    const workspaceActions = get().getWorkspaceActions()
    const currentWorkspace = workspaceActions?.getCurrentWorkspace()

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
              claudeProjectName: session.claudeProjectName,
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
        log.warn('获取 IFlow 会话失败', { error: String(e) })
      }

      // 4. 获取 Codex 会话列表
      try {
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

  restoreFromHistory: async (sessionId, engineId, projectPath, claudeProjectName) => {
    try {
      set({ isLoadingHistory: true })

      // ========== 1. 准备工作区 ==========
      let workspaceId: string | undefined
      let workspaceName: string | undefined

      if (projectPath) {
        // 查找已存在的工作区
        const workspaces = useWorkspaceStore.getState().workspaces
        const existingWorkspace = workspaces.find(w => w.path === projectPath)

        if (existingWorkspace) {
          workspaceId = existingWorkspace.id
          workspaceName = existingWorkspace.name
          log.debug('找到已存在的工作区', { workspaceId, workspaceName })
        } else {
          // 工作区不存在，自动创建
          workspaceName = getPathBasename(projectPath)
          log.info('工作区不存在，自动创建', { projectPath, workspaceName })

          try {
            // 创建工作区但不切换
            await useWorkspaceStore.getState().createWorkspace(workspaceName, projectPath, false)
            // 获取新创建的工作区
            const newWorkspaces = useWorkspaceStore.getState().workspaces
            const newWorkspace = newWorkspaces.find(w => w.path === projectPath)
            if (newWorkspace) {
              workspaceId = newWorkspace.id
            }
          } catch (e) {
            log.warn('创建工作区失败，将创建自由会话', { error: String(e), projectPath })
            // 工作区创建失败，继续创建自由会话
          }
        }
      }

      // ========== 2. 从历史源加载消息 ==========
      let chatMessages: ChatMessage[] = []
      let title = '恢复的会话'
      let externalSessionId: string | undefined

      // 2.1 尝试从 localStorage 恢复
      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const localHistory = historyJson ? JSON.parse(historyJson) : []
      const localSession = localHistory.find((h: HistoryEntry) => h.id === sessionId)

      if (localSession) {
        chatMessages = localSession.data.messages || []
        title = localSession.title
        externalSessionId = localSession.id
        log.debug('从本地历史加载消息', { messageCount: chatMessages.length, title })
      }
      // 2.2 尝试从 Claude Code 原生历史恢复
      else if (!engineId || engineId === 'claude-code') {
        const claudeCodeService = getClaudeCodeHistoryService()
        // 使用 claudeProjectName 定位 jsonl 文件，而非 projectPath
        const messages = await claudeCodeService.getSessionHistory(sessionId, claudeProjectName)

        if (messages.length > 0) {
          chatMessages = claudeCodeService.convertToChatMessages(messages)
          title = '恢复的会话' // Claude Code 历史没有标题，使用默认
          externalSessionId = sessionId
          log.debug('从 Claude Code 历史加载消息', { messageCount: chatMessages.length })
        }
      }
      // 2.3 尝试从 IFlow 恢复
      else if (engineId === 'iflow') {
        const iflowService = getIFlowHistoryService()
        const messages = await iflowService.getSessionHistory(sessionId)

        if (messages.length > 0) {
          const convertedMessages = iflowService.convertMessagesToFormat(messages)
          chatMessages = convertedMessages.map((msg) => {
            if (msg.role === 'user') {
              return {
                id: msg.id,
                type: 'user' as const,
                content: msg.content,
                timestamp: msg.timestamp,
              } satisfies UserChatMessage
            } else if (msg.role === 'assistant') {
              return {
                id: msg.id,
                type: 'assistant' as const,
                blocks: [{ type: 'text', content: msg.content }],
                timestamp: msg.timestamp,
                content: msg.content,
                toolSummary: msg.toolSummary,
              } satisfies AssistantChatMessage
            } else {
              return {
                id: msg.id,
                type: 'system' as const,
                content: msg.content,
                timestamp: msg.timestamp,
              } satisfies SystemChatMessage
            }
          })
          externalSessionId = sessionId
          log.debug('从 IFlow 历史加载消息', { messageCount: chatMessages.length })
        }
      }
      // 2.4 尝试从 Codex 恢复
      else if (engineId === 'codex') {
        const messages = await getCodexSessionHistory(sessionId)

        if (messages && messages.length > 0) {
          chatMessages = messages.map((msg) => {
            if (msg.type === 'user') {
              return {
                id: msg.id,
                type: 'user' as const,
                content: msg.content,
                timestamp: msg.timestamp,
              } satisfies UserChatMessage
            } else {
              return {
                id: msg.id,
                type: 'assistant' as const,
                blocks: [{ type: 'text', content: msg.content }],
                timestamp: msg.timestamp,
                content: msg.content,
              } satisfies AssistantChatMessage
            }
          })
          externalSessionId = sessionId
          log.debug('从 Codex 历史加载消息', { messageCount: chatMessages.length })
        }
      }

      // ========== 3. 检查是否成功加载消息 ==========
      if (chatMessages.length === 0) {
        log.warn('无法从历史加载消息', { sessionId, engineId })
        return false
      }

      // ========== 4. 创建新会话并加载消息 ==========
      const newSessionId = sessionStoreManager.getState().createSessionFromHistory(
        chatMessages,
        externalSessionId || null,
        { title, workspaceId }
      )

      log.info('从历史恢复成功，已创建新会话', {
        sessionId: newSessionId,
        title,
        workspaceId,
        messageCount: chatMessages.length,
        originalSessionId: sessionId,
      })

      return true
    } catch (e) {
      log.error('从历史恢复失败', e instanceof Error ? e : new Error(String(e)))
      return false
    } finally {
      set({ isLoadingHistory: false })
    }
  },

  deleteHistorySession: (sessionId, source) => {
    try {
      if (source === 'iflow' || (!source && sessionId.startsWith('session-'))) {
        log.debug('IFlow 会话无法删除，仅作忽略', { sessionId })
        return
      }
      if (source === 'codex') {
        log.debug('Codex 会话无法删除，仅作忽略', { sessionId })
        return
      }

      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const history = historyJson ? JSON.parse(historyJson) : []

      const filteredHistory = history.filter((h: HistoryEntry) => h.id !== sessionId)
      localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(filteredHistory))
    } catch (e) {
      log.error('删除历史会话失败', e instanceof Error ? e : new Error(String(e)))
    }
  },

  clearHistory: () => {
    try {
      localStorage.removeItem(SESSION_HISTORY_KEY)
      log.info('历史已清空')
    } catch (e) {
      log.error('清空历史失败', e instanceof Error ? e : new Error(String(e)))
    }
  },
})
