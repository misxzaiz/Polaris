import type { ChatMessage, EngineId, Workspace } from '@/types'
import type { SessionRuntimeConfig } from '@/types/sessionConfig'
import { sessionStoreManager } from './sessionStoreManager'
import { normalizeEngineId } from '@/utils/engineDisplay'
import { listPluginMcpServerStatuses } from '@/plugin-system'
import { usePluginStore } from '../pluginStore'
import { getUserSystemPrompt } from '@/services/workspaceReference'
import { toAppError, ErrorSource } from '@/types/errors'
import { OFFICIAL_API_PROFILE } from '@/types/modelProfile'
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
    // Claude 模型别名（opus/sonnet/haiku）对 codex/mimo 无意义：codex 有自己的模型名，
    // mimo 要求 provider/model 格式，透传会导致 CLI 报错
    model: (engineId === 'codex' || engineId === 'mimo') && model && CLAUDE_MODEL_ALIASES.has(model) ? undefined : model,
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
 * 解析发送 / 继续消息时最终生效的模型 Profile ID。
 *
 * 三态优先级：
 * 1. 会话级覆盖（SessionMetadata.modelProfileId）—— 最高优先级、三态权威：
 *    - 哨兵 OFFICIAL_API_PROFILE 或空串 → 用户明确选官方 API，返回 undefined（不使用任何 Profile）
 *    - 具体 id → 使用该 Profile
 *    - undefined → 从未设置，向下降级
 * 2. 状态栏镜像（sessionConfig.modelProfileId）
 * 3. 设置页激活的全局默认（globalActiveProfileId）
 *
 * 返回 `undefined` 表示「走官方端点」。哨兵值绝不会作为结果返回，确保不透传后端
 * （后端按 id 查找，拿到哨兵会命中 notFoundRuntime 中断请求）。
 */
export function resolveEffectiveProfileId(
  sessionMetaProfileId: string | undefined,
  sessionConfigProfileId: string | undefined,
  globalActiveProfileId: string | undefined,
): string | undefined {
  // 会话级覆盖存在（含「明确官方」）时以它为准，不再向下降级
  if (sessionMetaProfileId !== undefined) {
    return sessionMetaProfileId === OFFICIAL_API_PROFILE || sessionMetaProfileId === ''
      ? undefined
      : sessionMetaProfileId
  }
  // 无会话级覆盖 → 降级状态栏镜像，再降级全局默认（两者按惯例只存真实 id 或空串）
  const fallback = sessionConfigProfileId || globalActiveProfileId
  return fallback && fallback !== OFFICIAL_API_PROFILE ? fallback : undefined
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
 * localStorage 历史解析缓存
 *
 * `hydrateFromLocalStorage` 是压缩消息的二级降级恢复路径：当 MessageCompactor
 * 内存快照被 LRU(20) 淘汰后，滚动恢复（onVisibleRangeChange）与持久化前恢复
 * （getPersistableMessages，session_end 触发）都会落到此处。该路径在长会话快速
 * 滚动时会被频繁触发——单次 range 变化可能对 safe zone 内多条压缩消息各调一次。
 * 而每次 `JSON.parse` 整段历史（最多 50 个会话的完整消息，含工具输出 / diff，
 * 可达数十 MB）会阻塞主线程，导致滚动卡顿。
 *
 * 这里以「raw 字符串值相等」为失效条件缓存解析结果：同一 raw 下只 parse 一次，
 * 后续命中走内存线性查找。`historyService.saveToHistory` 写入新历史后 raw 改变，
 * 下次调用自动重建——无需跨模块通知，零耦合。
 */
const historyCache: { raw: string | null; entries: HistoryEntry[] } = {
  raw: null,
  entries: [],
}

/** 读取并缓存 localStorage 历史条目（raw 不变时复用解析结果） */
function getHistoryEntries(): HistoryEntry[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(SESSION_HISTORY_KEY)
  } catch {
    raw = null
  }

  if (raw === historyCache.raw) {
    return historyCache.entries
  }

  let entries: HistoryEntry[] = []
  if (raw) {
    try {
      entries = JSON.parse(raw) as HistoryEntry[]
    } catch {
      entries = []
    }
  }

  historyCache.raw = raw
  historyCache.entries = entries
  return entries
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
  const entries = getHistoryEntries()
  const entry = entries.find((e) => e.id === conversationId)
  if (!entry?.data?.messages) return null
  const found = entry.data.messages.find((m) => m.id === messageId)
  if (!found || !isValidMessageStructure(found)) return null
  return found
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
