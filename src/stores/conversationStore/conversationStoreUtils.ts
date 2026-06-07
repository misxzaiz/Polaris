import type { ChatMessage, EngineId, Workspace } from '@/types'
import type { SessionRuntimeConfig } from '@/types/sessionConfig'
import { sessionStoreManager } from './sessionStoreManager'
import { normalizeEngineId } from '@/utils/engineDisplay'
import { listPluginMcpServerStatuses } from '@/plugin-system'
import { usePluginStore } from '../pluginStore'
import { getUserSystemPrompt } from '@/services/workspaceReference'
import { toAppError, ErrorSource } from '@/types/errors'
import i18n from 'i18next'

export function resolveSessionEngine(sessionId: string, configEngineId?: string): EngineId {
  const metadataEngineId = sessionStoreManager.getState().sessionMetadata.get(sessionId)?.engineId
  return normalizeEngineId(metadataEngineId || configEngineId)
}

const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku'])

export function resolveRuntimeConfigForEngine(
  sessionConfig: SessionRuntimeConfig,
  engineId: EngineId
): Partial<SessionRuntimeConfig> {
  const model = sessionConfig.model || undefined

  return {
    agent: engineId === 'claude-code' ? sessionConfig.agent || undefined : undefined,
    model: engineId === 'codex' && model && CLAUDE_MODEL_ALIASES.has(model) ? undefined : model,
    effort: engineId === 'claude-code' ? sessionConfig.effort || undefined : undefined,
    permissionMode: sessionConfig.permissionMode || undefined,
  }
}

export function getDisabledPluginMcpServers(): string[] {
  return listPluginMcpServerStatuses(usePluginStore.getState().pluginStates)
    .filter((server) => !server.enabled)
    .map((server) => server.id)
}

/**
 * 解析聊天发送/继续时的错误为可展示文案。
 *
 * 后端业务错误（i18n key，以 `errors:` 开头，如 `errors:modelProfile.notFoundRuntime`）
 * 原样透传给 ErrorBanner（其内部会按 key 翻译）；其余错误按 AI 来源包装为泛化文案。
 */
export function resolveChatError(e: unknown, context: Record<string, unknown>): string {
  const raw = typeof e === 'string' ? e : e instanceof Error ? e.message : ''
  if (raw.startsWith('errors:')) {
    return raw
  }
  return toAppError(e, { source: ErrorSource.AI, context }).getUserMessage()
}

// ============================================================================
// 历史消息降级恢复
// ============================================================================

/** localStorage 历史记录 key（与 historyService 保持一致） */
const SESSION_HISTORY_KEY = 'event_chat_session_history'

interface HistoryData {
  messages: ChatMessage[]
}

interface HistoryEntry {
  id: string
  data: HistoryData
}

/**
 * 校验 localStorage 恢复的消息是否具有完整结构
 * 防止因数据污染或版本不兼容导致坏数据注入 store
 */
export function isValidMessageStructure(msg: unknown): msg is ChatMessage {
  if (!msg || typeof msg !== 'object') return false
  const m = msg as Record<string, unknown>
  if (typeof m.id !== 'string' || typeof m.type !== 'string' || typeof m.timestamp !== 'string') return false
  // assistant 消息必须有 blocks 数组
  if (m.type === 'assistant') return Array.isArray(m.blocks)
  // user 消息必须有 content 字符串
  if (m.type === 'user') return typeof m.content === 'string'
  return true
}

/**
 * 从 localStorage 恢复指定消息的完整数据
 * 用于 compactor 快照被 LRU 淘汰后的降级恢复
 */
export function hydrateFromLocalStorage(
  conversationId: string | null,
  messageId: string
): ChatMessage | null {
  if (!conversationId) return null
  try {
    const raw = localStorage.getItem(SESSION_HISTORY_KEY)
    if (!raw) return null
    const entries: HistoryEntry[] = JSON.parse(raw)
    const entry = entries.find(e => e.id === conversationId)
    if (!entry?.data?.messages) return null
    const found = entry.data.messages.find(m => m.id === messageId)
    if (!found || !isValidMessageStructure(found)) return null
    return found
  } catch {
    return null
  }
}

/**
 * 从用户消息生成标题
 * 取前 16 个字符作为标题，超出的部分用省略号
 */
export function generateTitleFromMessage(content: string): string {
  const cleanContent = content.replace(/\n/g, ' ').trim()
  const maxTitleLength = 16
  if (cleanContent.length <= maxTitleLength) {
    return cleanContent
  }
  return cleanContent.slice(0, maxTitleLength) + '...'
}

// ============================================================================
// 工作区提示词构建
// ============================================================================

export interface WorkspacePrompts {
  workspacePrompt: string
  userPrompt: string | null
  contextWorkspaces: Workspace[]
  allWorkspaces: Workspace[]
}

/**
 * 构建工作区系统提示词和用户自定义提示词
 * sendMessage 和 continueChat 共用
 */
export function buildWorkspacePrompts(
  getWorkspace: () => Workspace | null,
  getContextWorkspaceIds: () => string[],
  getAllWorkspaces: () => Workspace[],
): WorkspacePrompts {
  const currentWorkspace = getWorkspace()
  const contextWorkspaceIds = getContextWorkspaceIds()
  const allWorkspaces = getAllWorkspaces()
  const contextWorkspaces = allWorkspaces.filter(w => contextWorkspaceIds.includes(w.id))

  let workspacePrompt = ''
  if (currentWorkspace) {
    workspacePrompt = i18n.t('systemPrompt:workingIn', { name: currentWorkspace.name }) + '\n' +
      i18n.t('systemPrompt:projectPath', { path: currentWorkspace.path }) + '\n' +
      i18n.t('systemPrompt:fileRefSyntax')
  }

  let userPrompt: string | null = null
  if (currentWorkspace) {
    userPrompt = getUserSystemPrompt(currentWorkspace, contextWorkspaces)
  }

  return { workspacePrompt, userPrompt, contextWorkspaces, allWorkspaces }
}

/**
 * 规范化文本用于 Tauri IPC 传输
 * 将换行符统一转义为 \\n 字面量
 */
export function normalizeForInvoke(text: string): string {
  return text
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\n/g, '\\n')
    .trim()
}
