/**
 * 历史管理服务
 *
 * 负责会话历史的存储、查询、恢复和删除。
 * 不依赖任何 Zustand store 的渲染，仅操作 localStorage + 自有 JSONL 存储 + 调用 sessionStoreManager。
 *
 * 数据源：
 * - 自有存储（self）：JSONL 文件，整存整取、无损、保序，默认数据源
 * - 引擎原生（claude-code-native / codex-native）：读取 AI 引擎自身的会话文件
 * - localStorage（local）：旧版轻量历史，作为降级兜底
 */

import type { ChatMessage, EngineId } from '@/types'
import { createLogger } from '@/utils/logger'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useViewStore } from '@/stores/index'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { getClaudeCodeHistoryService } from './claudeCodeHistoryService'
import { getCodexHistoryService } from './codexHistoryService'
import { normalizeEngineId } from '@/utils/engineDisplay'
import { getPathBasename, normalizeWorkspacePath } from '@/utils/workspacePath'
import { dialogStorageService } from './dialogStorage'

const log = createLogger('HistoryService')

const SESSION_HISTORY_KEY = 'event_chat_session_history'
const MAX_SESSION_HISTORY = 50

// ============================================================================
// 类型定义
// ============================================================================

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

/** 统一的历史条目 */
export interface UnifiedHistoryItem {
  id: string
  title: string
  timestamp: string
  messageCount: number
  engineId: EngineId
  source: 'self' | 'local' | 'claude-code-native' | 'codex-native'
  fileSize?: number
  inputTokens?: number
  outputTokens?: number
  projectPath?: string
  claudeProjectName?: string
  /** 首条用户消息摘要（用于列表二级预览 + 搜索） */
  snippet?: string

  // === Fork 关系字段 ===
  parentSessionId?: string
  childSessionIds?: string[]

  // === Git/PR 关联字段 ===
  gitBranch?: string
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
export type HistoryEngineFilter = Extract<EngineId, 'claude-code' | 'codex' | 'mimo' | 'simple-ai'>

// ============================================================================
// 工具函数
// ============================================================================

function withAssistantEngineId(messages: ChatMessage[], engineId: EngineId): ChatMessage[] {
  return messages.map((message) => {
    if (message.type !== 'assistant' || message.engineId) return message
    return { ...message, engineId }
  })
}

/** 根据 workspaceId 查询工作区路径 */
function resolveWorkspacePath(workspaceId: string | null | undefined): string | null {
  if (!workspaceId) return null
  const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)
  return ws?.path ?? null
}

// ============================================================================
// 服务实现
// ============================================================================

export const historyService = {
  // ============================================================================
  // 保存
  // ============================================================================

  /** 保存当前活跃会话到历史（localStorage + 自有 JSONL 双写） */
  async saveToHistory(title?: string): Promise<void> {
    try {
      const sessionId = sessionStoreManager.getState().activeSessionId
      if (!sessionId) return
      const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
      if (!store || !store.conversationId || store.messages.length === 0) return

      const metadata = sessionStoreManager.getState().sessionMetadata.get(sessionId)
      const engineId = normalizeEngineId(metadata?.engineId)

      const firstUserMessage = store.messages.find((m) => m.type === 'user')
      let sessionTitle = title || '新对话'
      if (!title && firstUserMessage && 'content' in firstUserMessage && firstUserMessage.content) {
        sessionTitle = (firstUserMessage.content as string).slice(0, 50)
      }

      // 持久化前恢复压缩态消息为完整态，避免把离屏压缩结果（output 清空 /
      // content 截断）写进 localStorage / JSONL 造成历史内容永久丢失。
      const persistMessages = store.getPersistableMessages()

      // 1. 保存 localStorage（旧版轻量历史，用于降级恢复）
      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const history: HistoryEntry[] = historyJson ? JSON.parse(historyJson) : []

      const historyEntry: HistoryEntry = {
        id: store.conversationId,
        title: sessionTitle,
        timestamp: new Date().toISOString(),
        messageCount: persistMessages.length,
        engineId,
        data: {
          messages: persistMessages,
          archivedMessages: store.archivedMessages,
        },
      }

      const filteredHistory = history.filter((h) => h.id !== store.conversationId)
      filteredHistory.unshift(historyEntry)
      const limitedHistory = filteredHistory.slice(0, MAX_SESSION_HISTORY)
      localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(limitedHistory))

      // 2. 保存自有 JSONL（整体覆写，幂等保序）
      await dialogStorageService.saveConversation({
        externalId: store.conversationId,
        engineId,
        title: sessionTitle,
        workspaceId: metadata?.workspaceId ?? null,
        workspacePath: resolveWorkspacePath(metadata?.workspaceId),
        messages: persistMessages,
      })

      log.info('会话已保存到历史', { sessionTitle })
    } catch (e) {
      log.error('保存历史失败', e instanceof Error ? e : new Error(String(e)))
    }
  },

  // ============================================================================
  // 查询
  // ============================================================================

  /**
   * 统一历史（默认自有优先，无数据时降级到 localStorage + 引擎原生）
   * 兼容旧调用方；双 Tab UI 请直接用 listSelfHistory / listNativeHistory。
   */
  async getUnifiedHistory(
    scope: HistoryScope = 'workspace',
    page: number = 1,
    pageSize: number = 20,
    engines: HistoryEngineFilter[] = ['claude-code'],
  ): Promise<PagedHistoryResult> {
    try {
      const selfResult = await this.listSelfHistory(page, pageSize, engines)
      if (selfResult.items.length > 0) return selfResult
      return await this.listNativeHistory(scope, page, pageSize, engines)
    } catch (e) {
      log.error('获取统一历史失败', e instanceof Error ? e : new Error(String(e)))
      return { items: [], total: 0, page, pageSize, totalPages: 0, hasMore: false }
    }
  },

  /** 自有存储历史（JSONL）——「自有存储」Tab 数据源 */
  async listSelfHistory(
    page: number,
    pageSize: number,
    engines: HistoryEngineFilter[],
    scope: HistoryScope = 'workspace',
  ): Promise<PagedHistoryResult> {
    try {
      // 多读取一些用于按引擎过滤后仍能填满页（自有会话量通常不大，直接全量读 meta）
      const all = await dialogStorageService.listConversations({
        page: 1,
        pageSize: Number.MAX_SAFE_INTEGER,
        sortOrder: 'desc',
      })

      const currentWorkspace = useWorkspaceStore.getState().getCurrentWorkspace()
      const normalizedCurrentPath = currentWorkspace?.path
        ? normalizeWorkspacePath(currentWorkspace.path)
        : null

      const filtered = all.items.filter((m) => {
        if (!engines.includes(m.engineId as HistoryEngineFilter)) return false
        if (scope === 'workspace' && normalizedCurrentPath && m.workspacePath) {
          return normalizeWorkspacePath(m.workspacePath) === normalizedCurrentPath
        }
        return true
      })

      const total = filtered.length
      const totalPages = Math.ceil(total / pageSize)
      const start = (page - 1) * pageSize
      const pageItems = filtered.slice(start, start + pageSize)

      const items: UnifiedHistoryItem[] = pageItems.map((m) => ({
        id: m.externalId,
        title: m.title,
        timestamp: m.updatedAt,
        messageCount: m.messageCount,
        engineId: m.engineId,
        source: 'self' as const,
        projectPath: m.workspacePath ?? undefined,
        snippet: m.firstUserText || undefined,
      }))

      return { items, total, page, pageSize, totalPages, hasMore: page < totalPages }
    } catch (e) {
      log.warn('读取自有历史失败', { error: e instanceof Error ? e.message : String(e) })
      return { items: [], total: 0, page, pageSize, totalPages: 0, hasMore: false }
    }
  },

  /** 引擎原生 + localStorage 历史——「引擎历史」Tab 数据源 */
  async listNativeHistory(
    scope: HistoryScope,
    page: number,
    pageSize: number,
    engines: HistoryEngineFilter[],
  ): Promise<PagedHistoryResult> {
    const currentWorkspace = useWorkspaceStore.getState().getCurrentWorkspace()
    const includeClaudeCode = engines.includes('claude-code')
    const includeCodex = engines.includes('codex')

    // 1. localStorage 轻量条目
    const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
    const localHistory: HistoryEntry[] = historyJson ? JSON.parse(historyJson) : []
    const localItems: UnifiedHistoryItem[] = localHistory
      .filter((h) =>
        engines.includes(normalizeEngineId(h.engineId || 'claude-code') as HistoryEngineFilter),
      )
      .map((h) => ({
        id: h.id,
        title: h.title,
        timestamp: h.timestamp,
        messageCount: h.messageCount,
        engineId: h.engineId || 'claude-code',
        source: 'local' as const,
      }))

    // 2. 后端分页 API
    const workDir = scope === 'workspace' ? currentWorkspace?.path ?? null : null
    const emptyPagedResult = { items: [], total: 0, page, pageSize, totalPages: 0 }
    const [claudePagedResult, codexPagedResult] = await Promise.all([
      includeClaudeCode
        ? getClaudeCodeHistoryService().listSessionsPaged({ page, pageSize, workDir })
        : Promise.resolve(emptyPagedResult),
      includeCodex
        ? getCodexHistoryService().listSessionsPaged({ page, pageSize, workDir })
        : Promise.resolve(emptyPagedResult),
    ])

    const claudeNativeItems: UnifiedHistoryItem[] = claudePagedResult.items.map((s) => ({
      id: s.sessionId,
      title: s.summary || '无标题会话',
      timestamp: s.updatedAt || s.createdAt || new Date().toISOString(),
      messageCount: s.messageCount ?? 0,
      engineId: 'claude-code' as const,
      source: 'claude-code-native' as const,
      fileSize: s.fileSize,
      projectPath: s.projectPath,
      claudeProjectName: s.claudeProjectName,
      parentSessionId: s.parentSessionId,
      childSessionIds: s.childSessionIds,
      gitBranch: s.gitBranch,
      linkedPr: s.linkedPr,
    }))
    const codexNativeItems: UnifiedHistoryItem[] = codexPagedResult.items.map((s) => ({
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
    const nativeIdSet = new Set(nativeItems.map((n) => n.id))
    const uniqueLocalItems = localItems.filter((l) => !nativeIdSet.has(l.id))
    const merged = [...uniqueLocalItems, ...nativeItems]
    merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    const total = claudePagedResult.total + codexPagedResult.total + uniqueLocalItems.length
    const totalPages = Math.ceil(total / pageSize)

    return { items: merged, total, page, pageSize, totalPages, hasMore: page < totalPages }
  },

  // ============================================================================
  // 恢复
  // ============================================================================

  /** 从历史恢复会话 */
  async restoreFromHistory(
    sessionId: string,
    engineId?: string,
    projectPath?: string,
    claudeProjectName?: string,
    titleHint?: string,
  ): Promise<boolean> {
    try {
      // 1. 加载消息（自有 → localStorage → 引擎原生）
      const loaded = await this.loadMessagesForItem(
        sessionId,
        engineId,
        projectPath,
        claudeProjectName,
        titleHint,
      )

      // 2. codex 允许空消息裸 resume（后端 continue 已有会话）；其他引擎空消息视为失败
      if (loaded.messages.length === 0 && loaded.engineId !== 'codex') {
        log.warn('无法从历史加载消息', { sessionId, engineId })
        return false
      }

      // 2. 准备工作区（优先用传入 projectPath，其次用自有存储记录的 workspacePath）
      const effectiveProjectPath = projectPath || loaded.workspacePath || undefined
      const workspaceId = await this.ensureWorkspace(effectiveProjectPath)

      // 3. 创建新会话
      const newSessionId = sessionStoreManager.getState().createSessionFromHistory(
        loaded.messages,
        loaded.externalSessionId || sessionId,
        {
          title: loaded.title,
          workspaceId,
          engineId: loaded.engineId,
          stableConversationId: loaded.stableConversationId || undefined,
          modelProfileId: loaded.modelProfileId || undefined,
          model: loaded.model || undefined,
        },
      )

      log.info('从历史恢复成功', {
        sessionId: newSessionId,
        source: loaded.source,
        title: loaded.title,
        messageCount: loaded.messages.length,
      })

      if (useViewStore.getState().multiSessionMode) {
        useViewStore.getState().addToMultiView(newSessionId)
      }

      return true
    } catch (e) {
      log.error('从历史恢复失败', e instanceof Error ? e : new Error(String(e)))
      return false
    }
  },

  /**
   * 加载某条历史的完整消息（统一入口，供恢复 / Fork 复用）
   * 优先级：自有 JSONL（无损）→ localStorage → 引擎原生
   */
  async loadMessagesForItem(
    sessionId: string,
    engineId?: string,
    _projectPath?: string,
    claudeProjectName?: string,
    titleHint?: string,
  ): Promise<{
    messages: ChatMessage[]
    title: string
    engineId: EngineId
    externalSessionId: string | null
    stableConversationId: string | null
    modelProfileId: string | null
    model: string | null
    workspacePath: string | null
    source: UnifiedHistoryItem['source']
  }> {
    // 1. 自有 JSONL（无损，含 blocks/附件）
    try {
      const record = await dialogStorageService.getConversation(sessionId)
      if (record && record.messages.length > 0) {
        return {
          messages: record.messages,
          title: record.meta.title,
          engineId: normalizeEngineId(engineId || record.meta.engineId),
          externalSessionId: sessionId,
          stableConversationId: record.meta.stableConversationId || null,
          modelProfileId: record.meta.modelProfileId || null,
          model: record.meta.model || null,
          workspacePath: record.meta.workspacePath,
          source: 'self',
        }
      }
    } catch (e) {
      log.warn('自有存储恢复失败，降级', { error: e instanceof Error ? e.message : String(e) })
    }

    // 2. localStorage
    const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
    const localHistory: HistoryEntry[] = historyJson ? JSON.parse(historyJson) : []
    const localSession = localHistory.find((h) => h.id === sessionId)

    // 2.1 Codex 原生（需要主动拉取消息）
    if (engineId === 'codex') {
      const codexService = getCodexHistoryService()
      const codexMessages = await codexService.getSessionHistory(sessionId)
      const messages = codexMessages.length > 0
        ? withAssistantEngineId(codexService.convertToChatMessages(codexMessages), 'codex')
        : []
      return {
        messages,
        title: localSession?.title || titleHint || '恢复的 Codex 会话',
        engineId: 'codex',
        externalSessionId: sessionId,
        stableConversationId: null,
        modelProfileId: null,
        model: null,
        workspacePath: null,
        source: 'codex-native',
      }
    }

    // 2.2 localStorage 命中
    if (localSession) {
      const restoredEngineId = normalizeEngineId(localSession.engineId || engineId)
      return {
        messages: withAssistantEngineId(localSession.data.messages || [], restoredEngineId),
        title: localSession.title,
        engineId: restoredEngineId,
        externalSessionId: localSession.id,
        stableConversationId: null,
        modelProfileId: null,
        model: null,
        workspacePath: null,
        source: 'local',
      }
    }

    // 3. Claude Code 原生
    if (!engineId || engineId === 'claude-code') {
      const claudeCodeService = getClaudeCodeHistoryService()
      const messages = await claudeCodeService.getSessionHistory(sessionId, claudeProjectName)
      if (messages.length > 0) {
        return {
          messages: withAssistantEngineId(
            claudeCodeService.convertToChatMessages(messages),
            'claude-code',
          ),
          title: titleHint || '恢复的会话',
          engineId: 'claude-code',
          externalSessionId: sessionId,
          stableConversationId: null,
          modelProfileId: null,
          model: null,
          workspacePath: null,
          source: 'claude-code-native',
        }
      }
    }

    return {
      messages: [],
      title: titleHint || '恢复的会话',
      engineId: normalizeEngineId(engineId),
      externalSessionId: sessionId,
      stableConversationId: null,
      modelProfileId: null,
      model: null,
      workspacePath: null,
      source: 'self',
    }
  },

  /** 确保工作区存在，返回 workspaceId */
  async ensureWorkspace(projectPath?: string): Promise<string | undefined> {
    if (!projectPath) return undefined

    const normalizedProjectPath = normalizeWorkspacePath(projectPath)
    const workspaces = useWorkspaceStore.getState().workspaces
    const existing = workspaces.find(
      (w) => normalizeWorkspacePath(w.path) === normalizedProjectPath,
    )
    if (existing) return existing.id

    try {
      const workspaceName = getPathBasename(projectPath)
      await useWorkspaceStore.getState().createWorkspace(workspaceName, projectPath, false)
      const created = useWorkspaceStore.getState().workspaces.find(
        (w) => normalizeWorkspacePath(w.path) === normalizedProjectPath,
      )
      return created?.id
    } catch (e) {
      log.warn('创建工作区失败，将创建自由会话', { error: String(e), projectPath })
      return undefined
    }
  },

  // ============================================================================
  // 删除 / 清空
  // ============================================================================

  /** 删除历史会话 */
  async deleteHistorySession(
    sessionId: string,
    source: UnifiedHistoryItem['source'] = 'self',
    engineId?: EngineId,
  ): Promise<void> {
    try {
      if (source === 'self') {
        await dialogStorageService.deleteConversation(sessionId)
        return
      }

      if (source === 'local') {
        const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
        const history: HistoryEntry[] = historyJson ? JSON.parse(historyJson) : []
        const filteredHistory = history.filter((h) => h.id !== sessionId)
        localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(filteredHistory))
        return
      }

      // 引擎原生
      const { invoke } = await import('../services/tauri')
      await invoke('delete_session', {
        sessionId,
        engineId: engineId || (source === 'codex-native' ? 'codex' : 'claude-code'),
      })
    } catch (e) {
      log.error('删除历史会话失败', e instanceof Error ? e : new Error(String(e)))
    }
  },

  /** 清空 localStorage 历史（自有 JSONL 文件请逐个删除） */
  clearHistory(): void {
    try {
      localStorage.removeItem(SESSION_HISTORY_KEY)
      log.info('历史已清空')
    } catch (e) {
      log.error('清空历史失败', e instanceof Error ? e : new Error(String(e)))
    }
  },
}
