/**
 * 会话续接（Session Handoff）
 *
 * 将一个已有会话的内容导出为 markdown 文件，并开启一个干净的新会话，
 * 在新会话输入框预填引导语，让 AI 通过 @ 引用读取该文件、了解此前进展后继续。
 *
 * 全部复用现成能力，无后端改动：
 * - 取内容：getClaudeCodeHistoryService().getSessionHistory（从磁盘 jsonl 读完整原文）
 * - 写文件：create_file（自动创建父目录）
 * - 建会话：sessionStoreManager.createSession（非静默模式自动激活）
 * - 预填：updateInputDraft（切换后 ChatInput 自动恢复草稿）
 * - 读文件：@ 引用（parseWorkspaceReferences 改写为绝对路径）+ CLI 原生 Read
 */

import i18n from 'i18next'
import { invoke } from '@/services/tauri'
import { joinPath } from '@/utils/path'
import { createLogger } from '@/utils/logger'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { getClaudeCodeHistoryService } from './claudeCodeHistoryService'
import type { UnifiedHistoryItem } from './historyService'
import type { ChatMessage, EngineId } from '@/types'
import { messagesToMarkdown } from '@/utils/sessionExport'
import { getPathBasename, normalizeWorkspacePath } from '@/utils/workspacePath'

const log = createLogger('SessionHandoff')

/** 续接导出目录（相对工作区根） */
const HANDOFF_DIR = '.polaris-handoff'

export interface HandoffEligibility {
  enabled: boolean
  /** 不可用原因的 i18n key（chat 命名空间，用于 tooltip 提示） */
  reasonKey?: string
}

/**
 * 判断某会话是否可执行续接
 *
 * 条件：Claude Code 引擎 + 已有 CLI 会话 ID + 已关联工作区
 */
export function getHandoffEligibility(sessionId: string): HandoffEligibility {
  const manager = sessionStoreManager.getState()
  const meta = manager.sessionMetadata.get(sessionId)
  const store = manager.stores.get(sessionId)?.getState()

  if (!meta || !store) return { enabled: false, reasonKey: 'handoff.reasonNoSession' }
  if (meta.engineId !== 'claude-code') return { enabled: false, reasonKey: 'handoff.reasonEngine' }
  if (!store.conversationId) return { enabled: false, reasonKey: 'handoff.reasonEmpty' }
  if (!meta.workspaceId) return { enabled: false, reasonKey: 'handoff.reasonNoWorkspace' }

  return { enabled: true }
}

export interface HandoffResult {
  ok: boolean
  newSessionId?: string
  /** 失败原因（用户可见消息） */
  error?: string
}

/**
 * 将会话续接到一个新会话
 */
export async function handoffSessionToNewSession(sessionId: string): Promise<HandoffResult> {
  const manager = sessionStoreManager.getState()
  const meta = manager.sessionMetadata.get(sessionId)
  const store = manager.stores.get(sessionId)?.getState()

  if (!meta || !store) {
    return { ok: false, error: i18n.t('chat:handoff.reasonNoSession') }
  }

  const conversationId = store.conversationId
  if (meta.engineId !== 'claude-code' || !conversationId || !meta.workspaceId) {
    return { ok: false, error: i18n.t('chat:handoff.notEligible') }
  }

  const workspace = useWorkspaceStore.getState().workspaces.find((w) => w.id === meta.workspaceId)
  if (!workspace?.path) {
    return { ok: false, error: i18n.t('chat:handoff.reasonNoWorkspace') }
  }

  try {
    // 1. 取完整原文（从磁盘 jsonl，不受前端消息压缩影响）
    const service = getClaudeCodeHistoryService()
    const rawMessages = await service.getSessionHistory(conversationId)
    if (rawMessages.length === 0) {
      return { ok: false, error: i18n.t('chat:handoff.emptyContent') }
    }
    const chatMessages = service.convertToChatMessages(rawMessages)

    // 2. 序列化 markdown
    const markdown = messagesToMarkdown(chatMessages, { title: meta.title })

    // 3. 写文件到工作区 .polaris-handoff/（create_file 自动创建父目录）
    const fileName = `${sanitizeFileName(meta.title)}-${conversationId.slice(0, 8)}.md`
    const relPath = `${HANDOFF_DIR}/${fileName}`
    const absPath = joinPath(workspace.path, relPath)
    await invoke('create_file', { path: absPath, content: markdown })
    log.info('会话已导出', { sessionId, conversationId, absPath, messageCount: chatMessages.length })

    // 4. 创建干净的新会话（同工作区；非静默模式自动激活）
    const newSessionId = manager.createSession({
      type: 'project',
      workspaceId: meta.workspaceId,
      title: i18n.t('chat:handoff.newSessionTitle', { title: meta.title }),
      engineId: meta.engineId,
    })

    // 5. 预填引导语：@ 引用（可能自动 Read）+ 自然语言指令（兜底，确保 AI 主动 Read）
    const newStore = manager.stores.get(newSessionId)?.getState()
    if (newStore) {
      const guide = i18n.t('chat:handoff.guidePrompt', { ref: `@${relPath}` })
      newStore.updateInputDraft({ text: guide, attachments: [] })
    }

    log.info('续接新会话已创建', { sessionId, newSessionId })
    return { ok: true, newSessionId }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    log.error('会话续接失败', err, { sessionId })
    return { ok: false, error: err.message }
  }
}

/** 清理文件名中的非法字符，并限制长度 */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, '_').trim()
  return (cleaned || 'session').slice(0, 60)
}

export interface HistoryHandoffEligibility {
  enabled: boolean
  reasonKey?: string
}

/**
 * 判断历史会话是否可续接。
 *
 * 最小版仅支持 Claude Code 历史；工作区优先使用历史 projectPath，
 * 若没有 projectPath，则回退当前工作区。
 */
export function getHistoryHandoffEligibility(
  item: UnifiedHistoryItem,
  fallbackWorkspaceId?: string | null,
): HistoryHandoffEligibility {
  if (item.engineId !== 'claude-code') return { enabled: false, reasonKey: 'handoff.reasonEngine' }
  if (!item.id) return { enabled: false, reasonKey: 'handoff.reasonNoSession' }
  if (!item.projectPath && !fallbackWorkspaceId) return { enabled: false, reasonKey: 'handoff.reasonNoWorkspace' }
  return { enabled: true }
}

/**
 * 将历史会话续接到一个新会话。
 */
export async function handoffHistorySessionToNewSession(
  item: UnifiedHistoryItem,
  fallbackWorkspaceId?: string | null,
): Promise<HandoffResult> {
  if (item.engineId !== 'claude-code') {
    return { ok: false, error: i18n.t('chat:handoff.reasonEngine') }
  }

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

    const markdown = messagesToMarkdown(chatMessages, { title: item.title })
    const fileName = `${sanitizeFileName(item.title)}-${item.id.slice(0, 8)}.md`
    const relPath = `${HANDOFF_DIR}/${fileName}`
    const absPath = joinPath(workspace.path, relPath)
    await invoke('create_file', { path: absPath, content: markdown })

    const manager = sessionStoreManager.getState()
    const newSessionId = manager.createSession({
      type: 'project',
      workspaceId,
      title: i18n.t('chat:handoff.newSessionTitle', { title: item.title }),
      engineId: 'claude-code',
    })

    const newStore = manager.stores.get(newSessionId)?.getState()
    if (newStore) {
      const guide = i18n.t('chat:handoff.guidePrompt', { ref: `@${relPath}` })
      newStore.updateInputDraft({ text: guide, attachments: [] })
    }

    log.info('历史会话续接新会话已创建', { sourceId: item.id, newSessionId, workspaceId, absPath })
    return { ok: true, newSessionId }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    log.error('历史会话续接失败', err, { sourceId: item.id })
    return { ok: false, error: err.message }
  }
}

async function loadHistoryChatMessages(item: UnifiedHistoryItem): Promise<ChatMessage[]> {
  const historyJson = localStorage.getItem('event_chat_session_history')
  const localHistory = historyJson ? JSON.parse(historyJson) : []
  const localSession = localHistory.find((h: { id: string }) => h.id === item.id)
  if (localSession?.data?.messages?.length > 0) {
    return withAssistantEngineId(localSession.data.messages, item.engineId)
  }

  const claudeCodeService = getClaudeCodeHistoryService()
  const messages = await claudeCodeService.getSessionHistory(item.id, item.claudeProjectName)
  return messages.length > 0
    ? withAssistantEngineId(claudeCodeService.convertToChatMessages(messages), 'claude-code')
    : []
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

