/**
 * AI 事件处理器
 *
 * 处理单个会话的 AI 事件，所有事件都应该已经包含 sessionId
 */

import { generateUUID } from '@/utils/uuid'
import { createLogger } from '@/utils/logger'
import type { AIEvent } from '@/ai-runtime'
import { isEditTool, extractEditDiff } from '@/utils/diffExtractor'
import { parseApplyPatch } from '@/utils/patchParser'
import type { PluginCardBlock, ChatMessage } from '@/types'
import { chatCardRegistry } from '@/plugin-system/chatCardRegistry'
import type { ConversationStore } from './types'
import { voiceNotificationService } from '@/services/voiceNotificationService'
import { sessionStoreManager } from './sessionStoreManager'
import { normalizeEngineId } from '@/utils/engineDisplay'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useCliInfoStore } from '@/stores/cliInfoStore'
import { dialogStorageService } from '@/services/dialogStorage'

const log = createLogger('EventHandler')

/**
 * 解析 MCP 工具结果为插件卡片数据。
 *
 * 优先级：
 * 1. structuredContent（MCP 标准结构化结果，如 PRD 预览的 artifact）
 * 2. 字符串结果中的 fenced ```json 块
 * 3. 字符串结果直接 JSON.parse
 * 4. 原始值（字符串/对象）兜底
 *
 * 解析失败不抛错，返回原始值由卡片组件自行防御。
 */
function parseCardData(result: unknown): unknown {
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>
    if (obj.structuredContent !== undefined) {
      return obj.structuredContent
    }
    return result
  }

  if (typeof result === 'string') {
    const fenced = result.match(/```json\s*([\s\S]*?)```/i)
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim())
      } catch {
        // 落到直接 parse
      }
    }
    try {
      return JSON.parse(result.trim())
    } catch {
      return result
    }
  }

  return result
}

/**
 * 处理单个会话的 AI 事件
 */
export function handleAIEvent(
  event: AIEvent,
  set: (partial: Partial<ConversationStore>) => void,
  get: () => ConversationStore,
): void {
  const state = get()

  switch (event.type) {
    case 'session_start':
      set({
        conversationId: event.sessionId,
        isStreaming: true,
        error: null,
        promptSuggestion: null,
      })
      // 轮次开始即落盘：把水位之后的消息（本轮用户消息；引擎轮换会话 ID/Fork 时为完整历史）
      // 增量写入 JSONL——用户消息从此不等轮末,发出即持久化。
      void flushNewMessages(get, set)
      log.info('Session started', { sessionId: event.sessionId })
      break

    case 'session_end': {
      cancelScheduledFlush(state.sessionId)
      state.finishMessage()
      set({
        isStreaming: false,
        progressMessage: null,
      })
      // 保存到自有 JSONL 存储（轮末规整覆写：合并保护 + 前缀保留 + seq 重排）
      // 必须用 get() 取 finishMessage() 之后的最新 state，否则会丢失最后一条 AI 回复
      saveDialog(get, set)

      log.info('Session ended', {
        sessionId: state.sessionId,
        reason: event.reason,
        isStreaming: false,
      })
      break
    }

    case 'token':
      state.appendTextBlock(event.value)
      break

    case 'thinking':
      state.appendThinkingBlock(event.content)
      break

    case 'assistant_message':
      state.appendTextBlock(event.content)
      break

    case 'tool_call_start': {
      const toolName = event.tool
      const callId = event.callId || generateUUID()
      state.appendToolCallBlock(callId, toolName, event.args)
      break
    }

    case 'tool_call_end': {
      const callId = event.callId || ''
      // event.result 经 Rust IPC 传递后已是 JS string，直接使用；
      // 仅当 result 为对象时才 JSON.stringify
      const output = typeof event.result === 'string'
        ? event.result
        : (event.result ? JSON.stringify(event.result, null, 2) : undefined)
      state.updateToolCallBlock(
        callId,
        event.success ? 'completed' : 'failed',
        output,
      )

      // 插件自定义卡片（result 模式）：按工具名查注册表，命中则追加独立卡片。
      // 与工具调用卡并存（双卡模式）。interaction 模式由独立的 plugin_card 事件驱动。
      if (event.success) {
        const cardEntry = chatCardRegistry.match(event.tool)
        if (cardEntry && cardEntry.mode === 'result') {
          const cardBlock: PluginCardBlock = {
            type: 'plugin_card',
            id: callId,
            pluginId: cardEntry.pluginId,
            cardId: cardEntry.cardId,
            toolName: event.tool,
            mode: 'result',
            status: 'ready',
            data: parseCardData(event.result),
            createdAt: new Date().toISOString(),
          }
          state.appendPluginCardBlock(cardBlock)
        }
      }

      // Edit 工具：提取 diff 数据写入 block
      const { currentMessage, toolBlockMap } = get()
      const blockIdx = currentMessage ? toolBlockMap.get(callId) : undefined
      if (blockIdx !== undefined && currentMessage) {
        const block = currentMessage.blocks[blockIdx]
        if (block?.type === 'tool_call' && isEditTool(block.name)) {
          const diff = extractEditDiff(block)
          if (diff) {
            state.updateToolCallBlockDiff(callId, diff)
          }
        }
        // apply_patch 工具：解析补丁信封，写入 patchData
        if (block?.type === 'tool_call' && block.name === 'apply_patch') {
          const patchInput = block.input?.input as string
          if (patchInput) {
            const parsed = parseApplyPatch(patchInput)
            if (parsed && parsed.files.length > 0) {
              state.updateToolCallBlockPatch(callId, parsed.files)
            }
          }
        }
      }
      break
    }

    case 'progress':
      set({ progressMessage: event.message || null })
      break

    case 'error':
      set({
        error: event.error,
        isStreaming: false,
        currentMessage: null,
      })
      // 语音提醒：错误提醒
      voiceNotificationService.notifyError()
      break

    case 'result':
      // 结果事件通常在 session_end 之后，忽略
      break

    case 'user_message':
      // 用户消息通常由前端发送，这里忽略
      break

    case 'plan_start':
      // PlanStartEvent only has sessionId and planId, use plan_content for full data
      state.appendPlanModeBlock(
        event.planId,
        event.sessionId,
        undefined, // title from plan_content event
        undefined,  // description from plan_content event
      )
      break

    case 'plan_content':
      // Full plan content including title, description, stages
      state.updatePlanModeBlock(
        event.planId,
        {
          title: event.title,
          description: event.description,
          stages: event.stages,
          status: event.status,
        },
      )
      break

    case 'plan_stage_update':
      state.updatePlanStageStatus(
        event.planId,
        event.stageId,
        event.status,
        event.tasks,
      )
      break

    case 'plan_approval_request':
      state.appendPermissionRequestBlock(
        event.planId,
        event.sessionId,
        [], // approval denials
      )
      break

    case 'plan_approval_result':
      state.updatePermissionRequestBlock(
        event.planId,
        event.approved ? 'approved' : 'denied',
      )
      break

    case 'plan_end':
      state.setActivePlan(null)
      break

    case 'agent_run_start':
      state.appendAgentRunBlock(
        event.taskId,
        event.agentType,
        event.capabilities,
      )
      break

    case 'agent_run_end':
      state.updateAgentRunBlock(event.taskId, {
        status: event.success ? 'success' : 'error',
        output: event.result,
        completedAt: new Date().toISOString(),
      })
      state.setActiveTask(null)
      break

    case 'permission_request':
      state.appendPermissionRequestBlock(
        `perm-${Date.now()}`, // generate a unique request ID
        event.sessionId,
        event.denials,
      )
      break

    case 'hook': {
      // Hook 可视化（克制）：仅在 hook 执行失败时用进度行提示，
      // 避免高频 hook（PreToolUse/PostToolUse）刷屏；成功/开始仅记录日志。
      // 完整 hook 时间线可后续做独立面板消费此事件。
      if (event.phase === 'completed' && event.outcome && event.outcome !== 'success') {
        set({ progressMessage: `🪝 ${event.hookEvent || event.hookName}: ${event.outcome}` })
      } else {
        log.debug('Hook event', {
          hookName: event.hookName,
          phase: event.phase,
          outcome: event.outcome,
        })
      }
      break
    }

    case 'prompt_suggestion':
      // 下一步提示建议：保存到 store，由输入框渲染为可点击气泡。
      // 仅保留最近一条；空字符串视为清除。
      set({ promptSuggestion: event.suggestion?.trim() ? event.suggestion : null })
      break

    case 'cli_init':
      // CLI 会话初始化：把动态能力数据（工具/MCP/skill/模型/斜杠命令）同步到全局 store，
      // 供输入框命令建议、状态栏等消费。每轮对话（每次 CLI 进程启动）都会刷新。
      useCliInfoStore.getState().updateFromInit({
        sessionId: event.sessionId,
        tools: event.tools,
        mcpServers: event.mcpServers,
        agents: event.agents,
        skills: event.skills,
        model: event.model ?? undefined,
        claudeCodeVersion: event.claudeCodeVersion ?? undefined,
        slashCommands: event.slashCommands,
      })
      break

    case 'context_compacted':
      // 上下文压缩完成（/compact 或 autoCompact）：插入分隔条块，
      // 标记此处之前的上下文已被摘要压缩。
      state.appendContextCompactBlock(event.trigger, event.preTokens, event.postTokens)
      set({ progressMessage: null })
      break

    case 'usage': {
      // token 用量：最近一轮覆盖 + output 跨轮累计，供状态栏计算上下文水位与成本。
      const prev = state.usageStats
      set({
        usageStats: {
          input: event.inputTokens,
          cacheCreation: event.cacheCreationInputTokens ?? 0,
          cacheRead: event.cacheReadInputTokens ?? 0,
          output: event.outputTokens,
          reasoning: event.reasoningOutputTokens,
          contextWindow: event.contextWindow,
          totalOutput: (prev?.totalOutput ?? 0) + event.outputTokens,
        },
      })
      break
    }

    // permission_result is handled via plan_approval_result
    // there is no separate permission_result event type

    case 'question': {
      // 新版事件携带 questions[] 全集；老路径仅有顶层 header/options 等字段，
      // 这里做向后兼容：缺 questions[] 时用首题摘要合成。
      const questions = event.questions && event.questions.length > 0
        ? event.questions.map(q => ({
            question: q.question,
            header: q.header,
            multiSelect: q.multiSelect,
            options: q.options,
            allowCustomInput: q.allowCustomInput,
          }))
        : [{
            question: event.header,
            header: event.categoryLabel || '',
            multiSelect: event.multiSelect,
            options: event.options,
            allowCustomInput: event.allowCustomInput,
          }]
      state.appendQuestionBlock(event.questionId, event.sessionId, questions)
      break
    }

    case 'question_answered': {
      // 新版携带 answers[] 数组；老路径只有顶层 selected/customInput
      const answers = event.answers && event.answers.length > 0
        ? event.answers
        : [{
            selected: event.selected || [],
            customInput: event.customInput,
          }]
      state.updateQuestionBlock(event.questionId, {
        answers,
        declined: event.declined,
      })
      break
    }

    case 'plugin_card': {
      const block: PluginCardBlock = {
        type: 'plugin_card',
        id: event.interactionId,
        pluginId: event.pluginId,
        cardId: event.cardId,
        toolName: event.toolName,
        mode: 'interaction',
        status: 'pending',
        data: event.payload,
        sessionId: event.sessionId,
        createdAt: new Date().toISOString(),
      }
      state.appendPluginCardBlock(block)
      break
    }

    case 'plugin_card_answered':
      state.updatePluginCardBlock(event.interactionId, {
        status: event.declined ? 'declined' : 'answered',
        response: event.result,
      })
      break

    // Task 事件 - 由 TaskStore 处理，不在 ConversationStore 范围内
    case 'task_metadata':
    case 'task_progress':
    case 'task_completed':
    case 'task_canceled':
      break

    // Todo 事件 - 由 TodoStore 处理，不在 ConversationStore 范围内
    case 'todo_created':
    case 'todo_updated':
    case 'todo_deleted':
    case 'todo_execution_started':
    case 'todo_execution_progress':
    case 'todo_execution_completed':
      break

    default: {
      // 穷尽性检查：如果所有 AIEvent 类型都已处理，此处应为 never
      const _exhaustive: never = event
      log.warn('Unhandled event type', { type: (_exhaustive as { type: string }).type })
    }
  }

  // WAL 兜底：本次事件若使 messages 增长（如问题流程中途归档 currentMessage），
  // 防抖调度一次增量落盘。session_start/session_end 的显式落盘已覆盖主路径，
  // 这里只兜边缘时机；无新消息时是零成本 no-op。
  if (event.type !== 'session_end') {
    scheduleDialogFlush(state.sessionId, get, set)
  }
}

/**
 * 提取会话保存所需的元数据（标题/引擎/工作区），saveDialog 与增量 flush 共用。
 */
function buildDialogMetaInput(state: ConversationStore, messages: ChatMessage[]): {
  engineId: ReturnType<typeof normalizeEngineId>
  title: string
  workspaceId: string | null
  workspacePath: string | null
} {
  const metadata = sessionStoreManager.getState().sessionMetadata.get(state.sessionId)
  const engineId = normalizeEngineId(metadata?.engineId)

  // 标题：优先首条用户消息，其次 metadata.title
  const firstUserMessage = messages.find((m) => m.type === 'user')
  let title = metadata?.title || '新会话'
  if (firstUserMessage && 'content' in firstUserMessage && firstUserMessage.content) {
    title = (firstUserMessage.content as string).slice(0, 50)
  }

  // 工作区路径（用于按项目过滤 / 恢复时定位工作区）
  let workspacePath: string | null = null
  if (metadata?.workspaceId) {
    const ws = useWorkspaceStore
      .getState()
      .workspaces.find((w) => w.id === metadata.workspaceId)
    workspacePath = ws?.path ?? null
  }

  return { engineId, title, workspaceId: metadata?.workspaceId ?? null, workspacePath }
}

// ============================================================================
// 增量落盘（WAL 崩溃保护）
// ============================================================================

/** 每会话一个 debounce 定时器：消息完成后短暂静默即落盘 */
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
const FLUSH_DEBOUNCE_MS = 1500

type GetState = () => ConversationStore
type SetState = (partial: Partial<ConversationStore>) => void

/** 调度一次防抖增量落盘（消息完成/出错等时机调用；session_end 的规整覆写会取消它） */
export function scheduleDialogFlush(sessionId: string, get: GetState, set: SetState): void {
  const state = get()
  if (!state.conversationId) return
  const baseSeq = state.persistedConversationId === state.conversationId ? state.persistedSeq : 0
  if (state.messages.length <= baseSeq) return

  const existing = flushTimers.get(sessionId)
  if (existing) clearTimeout(existing)
  flushTimers.set(
    sessionId,
    setTimeout(() => {
      flushTimers.delete(sessionId)
      void flushNewMessages(get, set)
    }, FLUSH_DEBOUNCE_MS),
  )
}

/** 取消挂起的防抖落盘（轮末规整覆写已覆盖全部内容时） */
export function cancelScheduledFlush(sessionId: string): void {
  const existing = flushTimers.get(sessionId)
  if (existing) {
    clearTimeout(existing)
    flushTimers.delete(sessionId)
  }
}

/**
 * 把水位之后的新完成消息增量追加到 JSONL（WAL）。
 *
 * - 消息刚完成即落盘 → 必然是完整态（未被离屏压缩），从时序上根绝"截断态入盘"。
 * - conversationId 变化（引擎轮换会话 ID / Fork 后首轮）→ 水位归零，完整历史写入新文件。
 * - 崩溃/刷新最多丢正在流式中的半条消息。
 */
async function flushNewMessages(get: GetState, set: SetState): Promise<void> {
  try {
    const state = get()
    const { conversationId, messages } = state
    if (!conversationId || messages.length === 0) return

    const sameFile = state.persistedConversationId === conversationId
    const baseSeq = sameFile ? state.persistedSeq : 0
    if (messages.length <= baseSeq) {
      if (!sameFile) {
        set({ persistedConversationId: conversationId, persistedSeq: 0 })
      }
      return
    }

    const newMessages = messages.slice(baseSeq)
    const metaInput = buildDialogMetaInput(state, messages)
    // 分页恢复的会话：messages[0] 的磁盘 seq 偏移（引擎轮换 conversationId 后
    // 仍保留偏移，为轮末从原文件复制前缀预留 seq 区间）
    const seqOffset = state.historyPaging?.earliestSeq ?? 0

    await dialogStorageService.appendConversationMessages(
      {
        externalId: conversationId,
        ...metaInput,
        messages: newMessages,
      },
      seqOffset + baseSeq,
    )

    // 成功后推进水位（期间 messages 可能又增长，只推进到本次覆盖的长度）
    const cur = get()
    if (cur.conversationId === conversationId) {
      set({
        persistedSeq: baseSeq + newMessages.length,
        persistedConversationId: conversationId,
      })
    }
  } catch (e) {
    // 落盘失败不影响会话；轮末规整覆写会兜底
    log.warn('增量落盘失败（轮末整体保存兜底）', { error: String(e) })
  }
}

/**
 * 保存会话到自有 JSONL 存储（轮末规整）
 *
 * 在 session_end 时整体覆写该会话文件（一个会话一个 .jsonl）。
 * 整存整取 → 幂等、保序、不重复；配合三道保护不丢内容：
 * 1. getPersistableMessages 用内存快照/磁盘缓存恢复压缩态；
 * 2. saveConversation 合并保护：仍为压缩态的消息不覆盖磁盘完整版；
 * 3. 分页恢复的会话保留磁盘前缀（窗口外的更早消息）。
 */
async function saveDialog(get: GetState, set: SetState): Promise<void> {
  try {
    const state = get()
    const { conversationId } = state
    if (!conversationId) return
    // store 中离屏消息可能已被压缩，持久化前必须恢复为完整态，
    // 否则压缩态（output 清空 / content 截断）会被写入 JSONL 永久丢失内容。
    const messages = state.getPersistableMessages()
    if (messages.length === 0) return

    const metaInput = buildDialogMetaInput(state, messages)
    const paging = state.historyPaging
    const baseSeq = paging?.earliestSeq ?? 0

    const { prefixCount } = await dialogStorageService.saveConversation({
      externalId: conversationId,
      ...metaInput,
      messages,
      baseSeq,
      prefixSourceExternalId: paging?.sourceId,
    })

    // 覆写后磁盘 seq 已重排为 [0..prefixCount+N)：校正水位与分页游标（前缀已自包含 → sourceId 指回自身）
    const cur = get()
    if (cur.conversationId === conversationId) {
      set({
        // 水位 = 本次实际落盘的条数（保存期间新到的消息留给下次 flush）
        persistedSeq: Math.min(messages.length, cur.messages.length),
        persistedConversationId: conversationId,
        historyPaging:
          prefixCount > 0
            ? { earliestSeq: prefixCount, hasMore: true, sourceId: conversationId }
            : null,
      })
    }

    log.info('会话已保存到 JSONL', { conversationId, messageCount: messages.length })
  } catch (e) {
    log.error('保存会话到 JSONL 失败', e instanceof Error ? e : new Error(String(e)))
  }
}
