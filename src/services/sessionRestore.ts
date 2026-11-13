/**
 * 会话恢复/分叉核心（plans/session-history-plugin-prd.md P0）
 *
 * 从 historyService 抽出的宿主保留部分：restoreFromHistory / forkSession /
 * ensureWorkspace。存在意义：
 * 1. v2-kernel 的 RecoveryCapability 依赖 restoreFromHistory（session-v2/kernel/v2-kernel.ts）；
 * 2. `__POLARIS_SESSION_API__` 会话桥（main.tsx）把 restore/fork 暴露给插件面板
 *    （history-desk 等），插件不得直连 sessionStoreManager。
 *
 * 历史面板 UI 外移（P4）后本模块留守宿主；loadMessagesForItem 等查询编排随面板出仓。
 */

import type { ChatMessage, EngineId } from '@/types'
import { createLogger } from '@/utils/logger'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useViewStore } from '@/stores/viewStore'
import { getPathBasename, normalizeWorkspacePath } from '@/utils/workspacePath'
import { useHistoryPrefsStore } from '@/stores/historyPrefsStore'
import { dedupeMessagesById, normalizeRecoveredMessages } from '@/stores/conversationStore/dedupMessages'
import { dialogStorageService } from './dialogStorage'
import { loadBackendMessages } from './sessionArchive'
import { getClaudeCodeHistoryService } from './claudeCodeHistoryService'
import { aiHistoryDispatch } from './aiHistoryDispatch'
import { normalizeEngineId } from '@/utils/engineDisplay'

const log = createLogger('SessionRestore')

/** 恢复/分叉的加载结果（与 historyService.loadMessagesForItem 返回形状一致） */
export interface LoadedSession {
  messages: ChatMessage[]
  title: string
  engineId: EngineId
  externalSessionId: string | null
  workspacePath: string | null
  source: 'self' | 'claude-code-native' | 'plugin-native'
  paging: { earliestSeq: number; hasMore: boolean; sourceId: string } | null
}

/**
 * 合并后端消息库中的消息（S6）。
 *
 * 归档（JSONL）与消息库共用同一套消息 id（Phase 2 后端 adopt 前端 id），
 * 因此合并是精确的：归档已有的 id 以归档为准，只追加归档缺失的消息。
 *
 * 防御：即便 id 仍有漂移（历史数据），也按 assistant 内容指纹二次收敛——
 * 同内容的消息不重复追加（避免「同内容不同 id」的重复 AI 回复）。
 */
async function mergeBackendMessages(
  conversationId: string,
  archived: ChatMessage[],
): Promise<ChatMessage[]> {
  const backend = await loadBackendMessages(conversationId)
  if (backend.length === 0) return archived
  const knownIds = new Set(archived.map((m) => m.id))
  const knownFps = new Set(
    archived
      .filter((m) => m.type === 'assistant')
      .map((m) => assistantTextFp(m))
      .filter(Boolean),
  )
  const extra = backend.filter((m) => {
    if (knownIds.has(m.id)) return false
    if (m.type === 'assistant') {
      const fp = assistantTextFp(m)
      if (fp && knownFps.has(fp)) return false
    }
    return true
  })
  if (extra.length === 0) return archived
  return normalizeRecoveredMessages([...archived, ...extra])
}

/** assistant 消息文本指纹（text 块 content 拼接 trim，与 jsonlCodec 同规则） */
function assistantTextFp(msg: ChatMessage): string {
  if (msg.type !== 'assistant' || !Array.isArray(msg.blocks)) return ''
  let s = ''
  for (const b of msg.blocks) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
      const c = (b as { content?: string }).content
      if (typeof c === 'string') s += c
    }
  }
  return s.trim()
}

function withAssistantEngineId(messages: ChatMessage[], engineId: EngineId): ChatMessage[] {
  return messages.map((message) => {
    if (message.type !== 'assistant' || message.engineId) return message
    return { ...message, engineId }
  })
}

/** 确保工作区存在，返回 workspaceId（无路径 → undefined 自由会话） */
export async function ensureWorkspace(projectPath?: string): Promise<string | undefined> {
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
}

/**
 * 加载某条历史的完整消息（统一入口，供恢复 / Fork / 插件桥复用）。
 * 优先级：自有 JSONL（无损，尾部优先分页）→ 后端消息库兜底 → 引擎原生。
 */
export async function loadMessagesForItem(
  sessionId: string,
  engineId?: string,
  _projectPath?: string,
  claudeProjectName?: string,
  titleHint?: string,
): Promise<LoadedSession> {
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
        messages: await mergeBackendMessages(
          sessionId,
          normalizeRecoveredMessages(dedupeMessagesById(page.messages) as ChatMessage[]),
        ),
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

  // 1b. 无 JSONL 归档（会话在首轮结束前被中断 / 归档尚未落盘）→ 用后端消息库兜底。
  try {
    const backendMessages = await mergeBackendMessages(sessionId, [])
    if (backendMessages.length > 0) {
      return {
        messages: backendMessages,
        title: '',
        engineId: normalizeEngineId(engineId),
        externalSessionId: sessionId,
        workspacePath: null,
        source: 'self',
        paging: null,
      }
    }
  } catch (e) {
    log.warn('后端消息库兜底读取失败', { error: e instanceof Error ? e.message : String(e) })
  }

  // 2. Claude Code 原生
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

  // 3. 插件引擎原生（通过后端 get_session_history 拉取 JSONL 消息）
  if (engineId && !['claude-code', 'simple-ai'].includes(engineId)) {
    try {
      const result = await aiHistoryDispatch<{ items: { role: string; content: string; messageId?: string; timestamp?: string }[] }>({
        action: 'get_session_history',
        sessionId,
        engineId,
        page: 1,
        pageSize: 10000,
      })
      if (result.items && result.items.length > 0) {
        const messages: ChatMessage[] = result.items
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m, idx): ChatMessage => {
            const id = m.messageId || `${m.role}-${idx}`
            const timestamp = m.timestamp || new Date().toISOString()
            if (m.role === 'assistant') {
              return {
                id,
                type: 'assistant',
                content: m.content,
                timestamp,
                blocks: [{ type: 'text' as const, content: m.content }],
              }
            }
            return {
              id,
              type: 'user',
              content: m.content,
              timestamp,
            }
          })
        return {
          messages: withAssistantEngineId(messages, normalizeEngineId(engineId)),
          title: titleHint || '恢复的会话',
          engineId: normalizeEngineId(engineId),
          externalSessionId: sessionId,
          workspacePath: null,
          source: 'plugin-native',
          paging: null,
        }
      }
    } catch (e) {
      log.warn('插件引擎会话恢复失败', { engineId, error: e instanceof Error ? e.message : String(e) })
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
}

/**
 * 从历史恢复会话到本端窗口（= 旧 historyService.restoreFromHistory 全链路）。
 * 返回新会话 id；失败返回 null。
 */
export async function restoreFromHistory(
  sessionId: string,
  engineId?: string,
  projectPath?: string,
  claudeProjectName?: string,
  titleHint?: string,
): Promise<string | null> {
  try {
    const loaded = await loadMessagesForItem(sessionId, engineId, projectPath, claudeProjectName, titleHint)
    if (loaded.messages.length === 0) {
      log.warn('无法从历史加载消息', { sessionId, engineId })
      return null
    }

    const effectiveProjectPath = projectPath || loaded.workspacePath || undefined
    const workspaceId = await ensureWorkspace(effectiveProjectPath)

    const newSessionId = sessionStoreManager.getState().createSessionFromHistory(
      loaded.messages,
      loaded.externalSessionId || sessionId,
      { title: loaded.title, workspaceId, engineId: loaded.engineId, paging: loaded.paging },
    )

    // 后端权威对账（Phase 4）：补全 JSONL 归档缺失的进行中轮次（失败不阻断）。
    if (loaded.externalSessionId || sessionId) {
      try {
        const { getKernel } = await import('@/session-v2/kernel/registry')
        const kernel = await getKernel()
        await kernel.resyncSession(newSessionId)
        log.info('恢复后 kernel 对账完成', { newSessionId })
      } catch (e) {
        log.warn('恢复后 kernel 对账失败（不阻断恢复）', { error: String(e) })
      }
    }

    log.info('从历史恢复成功', {
      sessionId: newSessionId,
      source: loaded.source,
      title: loaded.title,
      messageCount: loaded.messages.length,
      paged: !!loaded.paging,
    })

    useViewStore.getState().addToMultiView(newSessionId)
    return newSessionId
  } catch (e) {
    log.error('从历史恢复失败', e instanceof Error ? e : new Error(String(e)))
    return null
  }
}

/**
 * 从历史会话创建分支（= 旧 SessionHistoryPanel.handleFork 编排）。
 * 返回新会话 id；失败返回 null。
 */
export async function forkSession(
  sessionId: string,
  engineId?: string,
  projectPath?: string,
  claudeProjectName?: string,
  branchName?: string,
): Promise<string | null> {
  try {
    // Fork 需要完整历史：不走分页，整份读取
    const record = await dialogStorageService.getConversation(sessionId)
    let messages: ChatMessage[] = record && record.messages.length > 0 ? record.messages : []
    if (messages.length === 0) {
      const loaded = await loadMessagesForItem(sessionId, engineId, projectPath, claudeProjectName)
      messages = loaded.messages
    }
    if (messages.length === 0) {
      log.warn('Fork 失败：无法加载会话消息', { sessionId })
      return null
    }

    const title = branchName || `Fork: 会话 ${sessionId.slice(0, 8)}`
    const workspaceId = await ensureWorkspace(projectPath)
    const newSessionId = sessionStoreManager.getState().createSessionFromHistory(
      messages,
      null, // 不传 conversationId，确保发消息走 start_chat
      {
        title,
        workspaceId,
        forkFromId: engineId === 'claude-code' ? sessionId : undefined,
        engineId: engineId as EngineId | undefined,
      },
    )
    log.info('Fork created', { newSessionId, sourceId: sessionId, branchName })
    useViewStore.getState().addToMultiView(newSessionId)
    return newSessionId
  } catch (e) {
    log.error('Fork failed', e instanceof Error ? e : new Error(String(e)))
    return null
  }
}
