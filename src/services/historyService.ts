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
import { invoke } from '@/services/transport'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useViewStore } from '@/stores/index'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { getClaudeCodeHistoryService } from './claudeCodeHistoryService'
import { getCodexHistoryService } from './codexHistoryService'
import { normalizeEngineId } from '@/utils/engineDisplay'
import { getPathBasename, normalizeWorkspacePath } from '@/utils/workspacePath'
import { dialogStorageService } from './dialogStorage'
import { useHistoryPrefsStore } from '@/stores/historyPrefsStore'

const log = createLogger('HistoryService')

const SESSION_HISTORY_KEY = 'event_chat_session_history'

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
  /** 最后一条消息摘要（续聊场景的卡片预览） */
  preview?: string

  // === 用户标注（索引层，self 与 native 会话统一） ===
  starred?: boolean
  pinned?: boolean
  archived?: boolean
  color?: string
  userTags?: string[]
  note?: string

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

/** 用户标注（history_mark 入参） */
export interface HistoryMarks {
  starred?: boolean
  pinned?: boolean
  archived?: boolean
  color?: string
  userTags?: string[]
  note?: string
}

/** 统一时间线查询选项 */
export interface UnifiedTimelineOptions {
  scope: HistoryScope
  page: number
  pageSize: number
  engines?: HistoryEngineFilter[]
  starred?: boolean
  archived?: boolean
  forceScan?: boolean
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

// ============================================================================
// 索引行（history_query / history_search 返回）
// ============================================================================

interface IndexSessionRow {
  id: string
  source: 'self' | 'claude-native' | 'codex-native' | string
  engineId: string
  title: string
  workspacePath: string | null
  createdAt: string
  updatedAt: string
  messageCount: number
  fileSize: number | null
  preview: string | null
  firstUserText: string | null
  gitBranch: string | null
  starred: boolean
  pinned: boolean
  archived: boolean
  color: string | null
  userTags: string[]
  note: string | null
  snippet?: string | null
}

interface IndexQueryResult {
  items: IndexSessionRow[]
  total: number
  page: number
  pageSize: number
}

function indexRowToItem(row: IndexSessionRow): UnifiedHistoryItem {
  const source: UnifiedHistoryItem['source'] =
    row.source === 'claude-native'
      ? 'claude-code-native'
      : row.source === 'codex-native'
        ? 'codex-native'
        : 'self'
  return {
    id: row.id,
    title: row.title || '未命名会话',
    timestamp: row.updatedAt || row.createdAt || new Date().toISOString(),
    messageCount: row.messageCount ?? 0,
    engineId: normalizeEngineId(row.engineId),
    source,
    fileSize: row.fileSize ?? undefined,
    projectPath: row.workspacePath ?? undefined,
    snippet: row.snippet ?? row.firstUserText ?? undefined,
    preview: row.preview ?? undefined,
    starred: row.starred,
    pinned: row.pinned,
    archived: row.archived,
    color: row.color ?? undefined,
    userTags: row.userTags ?? [],
    note: row.note ?? undefined,
    gitBranch: row.gitBranch ?? undefined,
  }
}

// ============================================================================
// 服务实现
// ============================================================================

export const historyService = {
  // ============================================================================
  // 统一时间线（SQLite 索引：self + native 合并、毫秒级、含标注）
  // ============================================================================

  /**
   * 统一时间线查询：self 与引擎原生会话按 sessionId 合并成一个列表。
   * 走后端 SQLite 索引（history_query）；后端不可达时降级到自有存储 meta 列举。
   */
  async listUnifiedTimeline(options: UnifiedTimelineOptions): Promise<PagedHistoryResult> {
    const { scope, page, pageSize } = options
    try {
      const currentWorkspace = useWorkspaceStore.getState().getCurrentWorkspace()
      const result = await invoke<IndexQueryResult>('history_query', {
        params: {
          workspacePath: scope === 'workspace' ? currentWorkspace?.path ?? null : null,
          engines:
            options.engines && options.engines.length > 0 ? options.engines : undefined,
          starred: options.starred || undefined,
          archived: options.archived ?? undefined,
          forceScan: options.forceScan || undefined,
          page,
          pageSize,
        },
      })
      const totalPages = Math.ceil(result.total / pageSize)
      return {
        items: result.items.map(indexRowToItem),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages,
        hasMore: page < totalPages,
      }
    } catch (e) {
      log.warn('索引查询失败，降级到自有存储列举', {
        error: e instanceof Error ? e.message : String(e),
      })
      return this.listSelfHistory(
        page,
        pageSize,
        options.engines ?? ['claude-code', 'codex', 'mimo', 'simple-ai'],
        scope,
      )
    }
  },

  /** 全文搜索（标题 + 消息正文，FTS5）；返回带命中片段的条目 */
  async searchHistory(query: string, scope: HistoryScope): Promise<UnifiedHistoryItem[]> {
    const q = query.trim()
    if (!q) return []
    try {
      const currentWorkspace = useWorkspaceStore.getState().getCurrentWorkspace()
      const rows = await invoke<IndexSessionRow[]>('history_search', {
        query: q,
        workspacePath: scope === 'workspace' ? currentWorkspace?.path ?? null : null,
        limit: 50,
      })
      return rows.map(indexRowToItem)
    } catch (e) {
      log.warn('全文搜索失败', { error: e instanceof Error ? e.message : String(e) })
      return []
    }
  },

  /** 更新会话标注（星标/置顶/归档/标签/颜色/备注）；对 self 与 native 会话一致生效 */
  async markHistory(id: string, marks: HistoryMarks): Promise<boolean> {
    try {
      await invoke<void>('history_mark', { id, marks })
      return true
    } catch (e) {
      log.warn('更新标注失败', { id, error: e instanceof Error ? e.message : String(e) })
      return false
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
      // 1. 加载消息（自有 → localStorage → 引擎原生）；自有存储走尾部优先分页
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
        { title: loaded.title, workspaceId, engineId: loaded.engineId, paging: loaded.paging },
      )

      log.info('从历史恢复成功', {
        sessionId: newSessionId,
        source: loaded.source,
        title: loaded.title,
        messageCount: loaded.messages.length,
        paged: !!loaded.paging,
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
   * 优先级：自有 JSONL（无损，尾部优先分页）→ localStorage → 引擎原生
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
    workspacePath: string | null
    source: UnifiedHistoryItem['source']
    /** 尾部优先分页信息（仅自有存储路径；null = 已全量加载） */
    paging: { earliestSeq: number; hasMore: boolean; sourceId: string } | null
  }> {
    // 1. 自有 JSONL（无损，含 blocks/附件）——尾部优先：首屏只取最近 N 条
    try {
      const restorePageSize = useHistoryPrefsStore.getState().restorePageSize
      const page = await dialogStorageService.getConversationPage(
        sessionId,
        null,
        restorePageSize,
      )
      if (page && page.messages.length > 0) {
        return {
          messages: page.messages,
          title: page.meta.title,
          engineId: normalizeEngineId(engineId || page.meta.engineId),
          externalSessionId: sessionId,
          workspacePath: page.meta.workspacePath,
          source: 'self',
          paging:
            page.hasMore && page.earliestSeq != null
              ? { earliestSeq: page.earliestSeq, hasMore: true, sourceId: sessionId }
              : null,
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
        workspacePath: null,
        source: 'codex-native',
        paging: null,
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
        workspacePath: null,
        source: 'local',
        paging: null,
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
          workspacePath: null,
          source: 'claude-code-native',
          paging: null,
        }
      }
    }

    return {
      messages: [],
      title: titleHint || '恢复的会话',
      engineId: normalizeEngineId(engineId),
      externalSessionId: sessionId,
      workspacePath: null,
      source: 'self',
      paging: null,
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
