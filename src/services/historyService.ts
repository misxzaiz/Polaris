/**
 * 历史管理服务
 *
 * 从 eventChatStore 的 historySlice 中提取的独立服务。
 * 负责会话历史的存储、查询、恢复和删除。
 * 不依赖任何 Zustand store，仅操作 localStorage + 调用 sessionStoreManager。
 */

import type { ChatMessage, EngineId } from '../types'
import { createLogger } from '../utils/logger'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { useViewStore } from '../stores/index'
import { sessionStoreManager } from '../stores/conversationStore/sessionStoreManager'
import { useConfigStore } from '../stores/configStore'
import { getClaudeCodeHistoryService } from './claudeCodeHistoryService'
import { getCodexHistoryService } from './codexHistoryService'
import { normalizeEngineId } from '../utils/engineDisplay'

const log = createLogger('HistoryService')

const SESSION_HISTORY_KEY = 'event_chat_session_history'
const MAX_SESSION_HISTORY = 50

/** 历史会话记录（localStorage 存储） */
export interface HistoryEntry {
  id: string
  title: string
  timestamp: string
  messageCount: number
  engineId: EngineId
  data: {
    messages: ChatMessage[]
    archivedMessages: ChatMessage[]
  }
}

/** 统一的历史条目（包含 localStorage 和 Claude Code 原生的会话） */
export interface UnifiedHistoryItem {
  id: string
  title: string
  timestamp: string
  messageCount: number
  engineId: EngineId
  source: 'local' | 'claude-code-native' | 'codex-native'
  fileSize?: number
  inputTokens?: number
  outputTokens?: number
  projectPath?: string
  claudeProjectName?: string

  // === Fork 关系字段 ===
  /** 父会话 ID（fork 来源） */
  parentSessionId?: string
  /** 子会话 ID 列表 */
  childSessionIds?: string[]

  // === Git/PR 关联字段 ===
  /** Git 分支名称 */
  gitBranch?: string
  /** PR 关联信息 */
  linkedPr?: {
    number: number
    url?: string
    title?: string
    state?: 'open' | 'merged' | 'closed'
  }
}

/** 分页历史结果 */
export interface PagedHistoryResult {
  items: UnifiedHistoryItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  hasMore: boolean
}

/** 历史查询范围 */
export type HistoryScope = 'workspace' | 'global'
export type HistoryEngineFilter = Extract<EngineId, 'claude-code' | 'codex'>

/** 从路径中提取名称 */
function getPathBasename(pathStr: string): string {
  const normalized = pathStr.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || pathStr
}

function withAssistantEngineId(messages: ChatMessage[], engineId: EngineId): ChatMessage[] {
  return messages.map(message => {
    if (message.type !== 'assistant' || message.engineId) return message
    return { ...message, engineId }
  })
}

export const historyService = {
  /** 保存当前活跃会话到历史 */
  saveToHistory(title?: string): void {
    try {
      const sessionId = sessionStoreManager.getState().activeSessionId
      if (!sessionId) return
      const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
      if (!store || !store.conversationId || store.messages.length === 0) return

      const config = useConfigStore.getState().config
      const engineId: EngineId = (config?.defaultEngine || 'claude-code') as EngineId

      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const history: HistoryEntry[] = historyJson ? JSON.parse(historyJson) : []

      const firstUserMessage = store.messages.find(m => m.type === 'user')
      let sessionTitle = title || '新对话'
      if (!title && firstUserMessage && 'content' in firstUserMessage) {
        sessionTitle = (firstUserMessage.content as string).slice(0, 50) + '...'
      }

      const historyEntry: HistoryEntry = {
        id: store.conversationId,
        title: sessionTitle,
        timestamp: new Date().toISOString(),
        messageCount: store.messages.length,
        engineId,
        data: {
          messages: store.messages,
          archivedMessages: store.archivedMessages,
        },
      }

      const filteredHistory = history.filter(h => h.id !== store.conversationId)
      filteredHistory.unshift(historyEntry)
      const limitedHistory = filteredHistory.slice(0, MAX_SESSION_HISTORY)

      localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(limitedHistory))
      log.info('会话已保存到历史', { sessionTitle })
    } catch (e) {
      log.error('保存历史失败', e instanceof Error ? e : new Error(String(e)))
    }
  },

  /** 聚合 localStorage + Claude Code 原生的统一历史列表（分页） */
  async getUnifiedHistory(
    scope: HistoryScope = 'workspace',
    page: number = 1,
    pageSize: number = 20,
    engines: HistoryEngineFilter[] = ['claude-code'],
  ): Promise<PagedHistoryResult> {
    const currentWorkspace = useWorkspaceStore.getState().getCurrentWorkspace()
    const includeClaudeCode = engines.includes('claude-code')
    const includeCodex = engines.includes('codex')

    try {
      // 1. 读取 localStorage 条目（轻量，最多 50 条）
      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const localHistory: HistoryEntry[] = historyJson ? JSON.parse(historyJson) : []

      const localItems: UnifiedHistoryItem[] = localHistory
        .filter(h => engines.includes(normalizeEngineId(h.engineId || 'claude-code') as HistoryEngineFilter))
        .map(h => ({
          id: h.id,
          title: h.title,
          timestamp: h.timestamp,
          messageCount: h.messageCount,
          engineId: h.engineId || 'claude-code',
          source: 'local' as const,
        }))

      // 2. 调用后端分页 API 获取原生会话
      const workDir = scope === 'workspace' ? (currentWorkspace?.path ?? null) : null
      const emptyPagedResult = { items: [], total: 0, page, pageSize, totalPages: 0 }
      const [claudePagedResult, codexPagedResult] = await Promise.all([
        includeClaudeCode
          ? getClaudeCodeHistoryService().listSessionsPaged({ page, pageSize, workDir })
          : Promise.resolve(emptyPagedResult),
        includeCodex
          ? getCodexHistoryService().listSessionsPaged({ page, pageSize, workDir })
          : Promise.resolve(emptyPagedResult),
      ])

      const claudeNativeItems: UnifiedHistoryItem[] = claudePagedResult.items.map(s => ({
        id: s.sessionId,
        title: s.summary || '无标题会话',
        timestamp: s.updatedAt || s.createdAt || new Date().toISOString(),
        messageCount: s.messageCount ?? 0,
        engineId: 'claude-code' as const,
        source: 'claude-code-native' as const,
        fileSize: s.fileSize,
        projectPath: s.projectPath,
        claudeProjectName: s.claudeProjectName,
        // Fork/PR 关系字段
        parentSessionId: s.parentSessionId,
        childSessionIds: s.childSessionIds,
        gitBranch: s.gitBranch,
        linkedPr: s.linkedPr,
      }))
      const codexNativeItems: UnifiedHistoryItem[] = codexPagedResult.items.map(s => ({
        id: s.sessionId,
        title: s.summary || 'Codex 对话',
        timestamp: s.updatedAt || s.createdAt || new Date().toISOString(),
        messageCount: s.messageCount ?? 0,
        engineId: 'codex' as const,
        source: 'codex-native' as const,
        fileSize: s.fileSize,
        projectPath: s.projectPath,
      }))

      const nativeItems = [...claudeNativeItems, ...codexNativeItems]

      // 3. 合并去重（localStorage 条目优先）
      const nativeIdSet = new Set(nativeItems.map(n => n.id))
      const uniqueLocalItems = localItems.filter(l => !nativeIdSet.has(l.id))

      // 4. 合并 + 排序
      const merged = [...uniqueLocalItems, ...nativeItems]
      merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

      // 5. 计算总数
      // localStorage 条目可能和后端条目重叠，实际 uniqueLocalItems 数量可能少于 total localItems
      // total 应为：后端 total + 去重后的 local 增量
      const total = claudePagedResult.total + codexPagedResult.total + uniqueLocalItems.length
      const totalPages = Math.ceil(total / pageSize)

      return {
        items: merged,
        total,
        page,
        pageSize,
        totalPages,
        hasMore: page < totalPages,
      }
    } catch (e) {
      log.error('获取统一历史失败', e instanceof Error ? e : new Error(String(e)))
      return { items: [], total: 0, page, pageSize, totalPages: 0, hasMore: false }
    }
  },

  /** 从历史恢复会话 */
  async restoreFromHistory(
    sessionId: string,
    engineId?: string,
    projectPath?: string,
    claudeProjectName?: string,
    titleHint?: string,
  ): Promise<boolean> {
    try {
      // 1. 准备工作区
      let workspaceId: string | undefined

      if (projectPath) {
        const workspaces = useWorkspaceStore.getState().workspaces
        const existingWorkspace = workspaces.find(w => w.path === projectPath)

        if (existingWorkspace) {
          workspaceId = existingWorkspace.id
        } else {
          const workspaceName = getPathBasename(projectPath)
          try {
            await useWorkspaceStore.getState().createWorkspace(workspaceName, projectPath, false)
            const newWorkspace = useWorkspaceStore.getState().workspaces.find(w => w.path === projectPath)
            if (newWorkspace) workspaceId = newWorkspace.id
          } catch (e) {
            log.warn('创建工作区失败，将创建自由会话', { error: String(e), projectPath })
          }
        }
      }

      // 2. 从历史源加载消息
      let chatMessages: ChatMessage[] = []
      let title = '恢复的会话'
      let externalSessionId: string | undefined
      let restoredEngineId: EngineId = normalizeEngineId(engineId)

      // 2.1 尝试从 localStorage 恢复
      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const localHistory = historyJson ? JSON.parse(historyJson) : []
      const localSession = localHistory.find((h: HistoryEntry) => h.id === sessionId)

      if (engineId === 'codex') {
        restoredEngineId = 'codex'
        // 拉取 Codex 原生历史消息，否则 UI 恢复后会显示空白
        const codexService = getCodexHistoryService()
        const codexMessages = await codexService.getSessionHistory(sessionId)
        if (codexMessages.length > 0) {
          chatMessages = withAssistantEngineId(
            codexService.convertToChatMessages(codexMessages),
            'codex',
          )
        }
        title = localSession?.title || titleHint || '恢复的 Codex 会话'
        externalSessionId = sessionId
      }
      else if (localSession) {
        restoredEngineId = normalizeEngineId(localSession.engineId || engineId)
        chatMessages = withAssistantEngineId(localSession.data.messages || [], restoredEngineId)
        title = localSession.title
        externalSessionId = localSession.id
      }
      // 2.2 尝试从 Claude Code 原生历史恢复
      else if (!engineId || engineId === 'claude-code') {
        const claudeCodeService = getClaudeCodeHistoryService()
        const messages = await claudeCodeService.getSessionHistory(sessionId, claudeProjectName)

        if (messages.length > 0) {
          restoredEngineId = 'claude-code'
          chatMessages = withAssistantEngineId(claudeCodeService.convertToChatMessages(messages), restoredEngineId)
          title = '恢复的会话'
          externalSessionId = sessionId
        }
      }

      if (chatMessages.length === 0 && restoredEngineId !== 'codex') {
        log.warn('无法从历史加载消息', { sessionId, engineId })
        return false
      }

      // 3. 创建新会话
      const newSessionId = sessionStoreManager.getState().createSessionFromHistory(
        chatMessages,
        externalSessionId || null,
        { title, workspaceId, engineId: restoredEngineId },
      )

      log.info('从历史恢复成功', { sessionId: newSessionId, title, messageCount: chatMessages.length })

      // 多窗口模式时，自动加入
      if (useViewStore.getState().multiSessionMode) {
        useViewStore.getState().addToMultiView(newSessionId)
      }

      return true
    } catch (e) {
      log.error('从历史恢复失败', e instanceof Error ? e : new Error(String(e)))
      return false
    }
  },

  /** 删除历史会话 */
  async deleteHistorySession(
    sessionId: string,
    source: UnifiedHistoryItem['source'] = 'local',
    engineId?: EngineId,
  ): Promise<void> {
    try {
      if (source !== 'local') {
        const { invoke } = await import('../services/tauri')
        await invoke('delete_session', {
          sessionId,
          engineId: engineId || (source === 'codex-native' ? 'codex' : 'claude-code'),
        })
        return
      }

      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const history: HistoryEntry[] = historyJson ? JSON.parse(historyJson) : []
      const filteredHistory = history.filter(h => h.id !== sessionId)
      localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(filteredHistory))
    } catch (e) {
      log.error('删除历史会话失败', e instanceof Error ? e : new Error(String(e)))
    }
  },

  /** 清空所有历史 */
  clearHistory(): void {
    try {
      localStorage.removeItem(SESSION_HISTORY_KEY)
      log.info('历史已清空')
    } catch (e) {
      log.error('清空历史失败', e instanceof Error ? e : new Error(String(e)))
    }
  },
}
