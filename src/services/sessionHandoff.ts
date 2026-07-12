/**
 * 会话续接（Session Handoff）— 跨引擎版
 *
 * 将一个已有会话的内容带入一个新会话（可用不同引擎），让新会话了解此前进展后继续。
 *
 * 设计首要约束：避免新会话初始上下文膨胀。按 resolveTransferMode 决策四种模式：
 * - fork          同引擎 + 目标支持 fork（claude-code / mimo）：--fork-session 原生续接，不占额外上下文（结构完整）
 * - full-file     源较短：全文落盘 + @ 引用注入（本身小，无负担）
 * - summary       默认：精简摘要落盘 + @ 引用注入（~1-2k token，控制上下文体积）
 * - message-history 仅 simple-ai 目标（直注 SessionOptions.message_history，管线未接，暂降级 summary）
 *
 * 复用现成能力，无后端改动：
 * - 取内容：loadConversationMessages（按引擎分流：claude-code/codex 原生历史 + self JSONL + 内存兜底）
 * - 写文件：ConversationPackager.packToFile / packToSummary（create_file 自动创建父目录）
 * - 建会话：sessionStoreManager.createSession（forkFromId → 首条消息时 --fork-session）
 * - 预填：updateInputDraft（切换后 ChatInput 自动恢复草稿）
 * - 读文件：@ 引用（parseWorkspaceReferences 改写为绝对路径）+ CLI 原生 Read
 */

import i18n from 'i18next'
import { createLogger } from '@/utils/logger'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { getClaudeCodeHistoryService } from './claudeCodeHistoryService'
import { getCodexHistoryService } from './codexHistoryService'
import { dialogStorageService } from './dialogStorage/service'
import type { UnifiedHistoryItem } from './historyService'
import type { ChatMessage, EngineId } from '@/types'
import {
  packToFile,
  packToSummary,
  resolveTransferMode,
  estimateTokens,
} from './conversationPackager'
import { normalizeEngineId } from '@/utils/engineDisplay'
import { getPathBasename, normalizeWorkspacePath } from '@/utils/workspacePath'

const log = createLogger('SessionHandoff')

export interface HandoffEligibility {
  enabled: boolean
  /** 不可用原因的 i18n key（chat 命名空间，用于 tooltip 提示） */
  reasonKey?: string
}

/**
 * 判断某会话是否可执行续接
 *
 * 条件：会话存在 + 已关联工作区 + 有可加载内容（conversationId 或内存消息）。
 * 不再限制引擎 —— 任意引擎的会话都可续接（跨引擎时走内容快照路径）。
 */
export function getHandoffEligibility(sessionId: string): HandoffEligibility {
  const manager = sessionStoreManager.getState()
  const meta = manager.sessionMetadata.get(sessionId)
  const store = manager.stores.get(sessionId)?.getState()

  if (!meta || !store) return { enabled: false, reasonKey: 'handoff.reasonNoSession' }
  if (!meta.workspaceId) return { enabled: false, reasonKey: 'handoff.reasonNoWorkspace' }
  if (!store.conversationId && store.messages.length === 0) {
    return { enabled: false, reasonKey: 'handoff.reasonEmpty' }
  }

  return { enabled: true }
}

export interface HandoffResult {
  ok: boolean
  newSessionId?: string
  /** 失败原因（用户可见消息） */
  error?: string
}

/**
 * 将会话续接到一个新会话（可指定目标引擎，默认沿用源引擎）。
 *
 * @param sessionId       源会话 ID
 * @param targetEngineId  目标引擎（省略则沿用源引擎，向后兼容）
 */
export async function handoffSessionToNewSession(
  sessionId: string,
  targetEngineId?: EngineId,
): Promise<HandoffResult> {
  const manager = sessionStoreManager.getState()
  const meta = manager.sessionMetadata.get(sessionId)
  const store = manager.stores.get(sessionId)?.getState()

  if (!meta || !store) {
    return { ok: false, error: i18n.t('chat:handoff.reasonNoSession') }
  }
  if (!meta.workspaceId) {
    return { ok: false, error: i18n.t('chat:handoff.reasonNoWorkspace') }
  }

  const sourceEngineId = normalizeEngineId(meta.engineId)
  const targetEngine = normalizeEngineId(targetEngineId ?? sourceEngineId)
  const conversationId = store.conversationId ?? ''

  const workspace = useWorkspaceStore.getState().workspaces.find((w) => w.id === meta.workspaceId)
  if (!workspace?.path) {
    return { ok: false, error: i18n.t('chat:handoff.reasonNoWorkspace') }
  }

  try {
    // 1. 取完整原文（按引擎分流：原生历史 / self JSONL / 内存兜底）
    // 内存兜底用持久化态（已恢复压缩消息），避免把离屏压缩结果作为续接原文。
    const fallbackMessages = [...store.getPersistableMessages(), ...(store.archivedMessages ?? [])]
    const chatMessages = await loadConversationMessages(sourceEngineId, conversationId, fallbackMessages)
    if (chatMessages.length === 0) {
      return { ok: false, error: i18n.t('chat:handoff.emptyContent') }
    }

    // 2. 按模式创建新会话
    return await createHandoffSession({
      messages: chatMessages,
      sourceTitle: meta.title,
      sourceEngineId,
      sourceConversationId: conversationId,
      targetEngineId: targetEngine,
      workspaceId: meta.workspaceId,
      workspacePath: workspace.path,
    })
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    log.error('会话续接失败', err, { sessionId })
    return { ok: false, error: err.message }
  }
}

export interface HistoryHandoffEligibility {
  enabled: boolean
  reasonKey?: string
}

/**
 * 判断历史会话是否可续接。
 *
 * 不再限制引擎。工作区优先使用历史 projectPath，若没有则回退当前工作区。
 */
export function getHistoryHandoffEligibility(
  item: UnifiedHistoryItem,
  fallbackWorkspaceId?: string | null,
): HistoryHandoffEligibility {
  if (!item.id) return { enabled: false, reasonKey: 'handoff.reasonNoSession' }
  if (!item.projectPath && !fallbackWorkspaceId) return { enabled: false, reasonKey: 'handoff.reasonNoWorkspace' }
  return { enabled: true }
}

/**
 * 将历史会话续接到一个新会话（可指定目标引擎，默认沿用源引擎）。
 */
export async function handoffHistorySessionToNewSession(
  item: UnifiedHistoryItem,
  fallbackWorkspaceId?: string | null,
  targetEngineId?: EngineId,
): Promise<HandoffResult> {
  try {
    const workspaceId = await resolveHistoryWorkspaceId(item, fallbackWorkspaceId)
    if (!workspaceId) {
      return { ok: false, error: i18n.t('chat:handoff.reasonNoWorkspace') }
    }

    const workspace = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)
    if (!workspace?.path) {
      return { ok: false, error: i18n.t('chat:handoff.reasonNoWorkspace') }
    }

    const chatMessages = await loadHistoryChatMessages(item)
    if (chatMessages.length === 0) {
      return { ok: false, error: i18n.t('chat:handoff.emptyContent') }
    }

    const sourceEngineId = normalizeEngineId(item.engineId)
    const targetEngine = normalizeEngineId(targetEngineId ?? sourceEngineId)

    return await createHandoffSession({
      messages: chatMessages,
      sourceTitle: item.title,
      sourceEngineId,
      sourceConversationId: item.id,
      targetEngineId: targetEngine,
      workspaceId,
      workspacePath: workspace.path,
    })
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    log.error('历史会话续接失败', err, { sourceId: item.id })
    return { ok: false, error: err.message }
  }
}

// ---------------------------------------------------------------------------
// 核心编排：按 transfer mode 创建新会话
// ---------------------------------------------------------------------------

interface CreateHandoffParams {
  messages: ChatMessage[]
  sourceTitle: string
  sourceEngineId: EngineId
  /** 源会话 id（fork 模式作 forkSessionId，文件名作 idSeed） */
  sourceConversationId: string
  targetEngineId: EngineId
  workspaceId: string
  workspacePath: string
}

/**
 * 按 resolveTransferMode 决策的模式创建续接新会话
 *
 * - fork：同引擎 + 目标支持 fork + 有 conversationId → createSession(forkFromId)，无引导语（引擎原生记忆）
 * - full-file：源较短 → packToFile + 引导语
 * - summary / message-history：默认 → packToSummary + 引导语（message-history 直注管线未接，暂降级 summary）
 */
async function createHandoffSession(params: CreateHandoffParams): Promise<HandoffResult> {
  const {
    messages, sourceTitle, sourceEngineId, sourceConversationId,
    targetEngineId, workspaceId, workspacePath,
  } = params

  const estimatedTokens = estimateTokens(messages)
  let mode = resolveTransferMode({
    sourceEngineId,
    targetEngineId,
    messageCount: messages.length,
    estimatedTokens,
  })

  // fork 必须有真实源会话 id；message-history 直注管线未接，暂降级 summary
  if (mode === 'fork' && !sourceConversationId) mode = 'summary'
  if (mode === 'message-history') mode = 'summary'

  const manager = sessionStoreManager.getState()
  const newTitle = i18n.t('chat:handoff.newSessionTitle', { title: sourceTitle })

  // fork 模式：引擎原生续接，不落盘、不预填引导语
  if (mode === 'fork') {
    const newSessionId = manager.createSession({
      type: 'project',
      workspaceId,
      title: newTitle,
      engineId: targetEngineId,
      forkFromId: sourceConversationId,
    })
    log.info('续接新会话已创建（fork）', { sourceConversationId, newSessionId, targetEngineId })
    return { ok: true, newSessionId }
  }

  // 内容快照模式：落盘 + 预填引导语
  const packer = mode === 'full-file' ? packToFile : packToSummary
  const { fileRef } = await packer(messages, sourceTitle, sourceConversationId, workspacePath)
  log.info('会话已导出', { mode, absPath: fileRef.absPath, messageCount: messages.length, targetEngineId })

  const newSessionId = manager.createSession({
    type: 'project',
    workspaceId,
    title: newTitle,
    engineId: targetEngineId,
  })

  const newStore = manager.stores.get(newSessionId)?.getState()
  if (newStore) {
    const guide = i18n.t('chat:handoff.guidePrompt', { ref: `@${fileRef.relPath}` })
    newStore.updateInputDraft({ text: guide, attachments: [] })
  }

  log.info('续接新会话已创建', { mode, newSessionId, targetEngineId })
  return { ok: true, newSessionId }
}

// ---------------------------------------------------------------------------
// 内容加载：按引擎分流
// ---------------------------------------------------------------------------

/**
 * 按引擎加载源会话完整消息（不受前端消息压缩影响）
 *
 * - claude-code / codex：从 CLI 原生历史文件读完整原文
 * - simple-ai / mimo：从 self JSONL 读完整原文
 * - 加载失败或无 conversationId：回退内存消息（可能已被压缩，记 warn）
 */
async function loadConversationMessages(
  engineId: EngineId,
  conversationId: string,
  fallbackMessages: ChatMessage[],
): Promise<ChatMessage[]> {
  if (conversationId) {
    try {
      if (engineId === 'claude-code') {
        const service = getClaudeCodeHistoryService()
        const raw = await service.getSessionHistory(conversationId)
        if (raw.length > 0) return withAssistantEngineId(service.convertToChatMessages(raw), engineId)
      } else if (engineId === 'codex') {
        const service = getCodexHistoryService()
        const raw = await service.getSessionHistory(conversationId)
        if (raw.length > 0) return withAssistantEngineId(service.convertToChatMessages(raw), engineId)
      } else {
        // simple-ai / mimo：self JSONL（externalId = conversationId）
        const msgs = await dialogStorageService.getConversationMessages(conversationId)
        if (msgs.length > 0) return withAssistantEngineId(msgs, engineId)
      }
    } catch (e) {
      log.warn('按引擎加载源会话失败，回退内存消息', { engineId, conversationId, error: String(e) })
    }
  }

  if (fallbackMessages.length > 0) {
    log.warn('使用内存消息作为续接源（可能已被压缩，内容可能不完整）', { engineId, conversationId })
    return withAssistantEngineId(fallbackMessages, engineId)
  }
  return []
}

/**
 * 按历史项 source/engineId 加载完整消息
 *
 * - claude-code-native / codex-native：CLI 原生历史
 * - self：self JSONL
 * - local：localStorage 旧版轻量历史
 */
async function loadHistoryChatMessages(item: UnifiedHistoryItem): Promise<ChatMessage[]> {
  const engineId = normalizeEngineId(item.engineId)

  // local 旧版历史优先（内存里有完整 messages）
  const historyJson = localStorage.getItem('event_chat_session_history')
  const localHistory = historyJson ? JSON.parse(historyJson) : []
  const localSession = localHistory.find((h: { id: string }) => h.id === item.id)
  if (localSession?.data?.messages?.length > 0) {
    return withAssistantEngineId(localSession.data.messages, engineId)
  }

  try {
    if (engineId === 'claude-code') {
      const service = getClaudeCodeHistoryService()
      const messages = await service.getSessionHistory(item.id, item.claudeProjectName)
      return messages.length > 0 ? withAssistantEngineId(service.convertToChatMessages(messages), engineId) : []
    }
    if (engineId === 'codex') {
      const service = getCodexHistoryService()
      const messages = await service.getSessionHistory(item.id)
      return messages.length > 0 ? withAssistantEngineId(service.convertToChatMessages(messages), engineId) : []
    }
    // simple-ai / mimo：self JSONL（externalId = item.id）
    const msgs = await dialogStorageService.getConversationMessages(item.id)
    return msgs.length > 0 ? withAssistantEngineId(msgs, engineId) : []
  } catch (e) {
    log.warn('加载历史会话消息失败', { sourceId: item.id, engineId, error: String(e) })
    return []
  }
}

function withAssistantEngineId(messages: ChatMessage[], engineId: EngineId): ChatMessage[] {
  return messages.map(message => {
    if (message.type !== 'assistant' || message.engineId) return message
    return { ...message, engineId }
  })
}

async function resolveHistoryWorkspaceId(
  item: UnifiedHistoryItem,
  fallbackWorkspaceId?: string | null,
): Promise<string | undefined> {
  const projectPath = item.projectPath?.trim()
  const workspaceState = useWorkspaceStore.getState()

  if (projectPath) {
    const normalizedProjectPath = normalizeWorkspacePath(projectPath)
    let workspace = workspaceState.workspaces.find(
      w => normalizeWorkspacePath(w.path) === normalizedProjectPath,
    )
    if (workspace) return workspace.id

    try {
      await workspaceState.createWorkspace(getPathBasename(projectPath), projectPath, false)
      workspace = useWorkspaceStore.getState().workspaces.find(
        w => normalizeWorkspacePath(w.path) === normalizedProjectPath,
      )
      if (workspace) return workspace.id
    } catch (error) {
      log.warn('Failed to resolve handoff workspace', { error: String(error), projectPath })
    }
  }

  return fallbackWorkspaceId ?? undefined
}
