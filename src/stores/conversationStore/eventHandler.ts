/**
 * AI 事件处理器
 *
 * 处理单个会话的 AI 事件，所有事件都应该已经包含 sessionId
 */

import { generateUUID } from '@/utils/uuid'
import { createLogger } from '@/utils/logger'
import type { AIEvent } from '@/ai-runtime'
import { isEditTool, extractEditDiff } from '@/utils/diffExtractor'
import type { ArtifactPreviewBlock } from '@/types'
import type { ConversationStore } from './types'
import { voiceNotificationService } from '@/services/voiceNotificationService'
import { useSessionStore } from '../index'
import { sessionStoreManager } from './sessionStoreManager'
import { normalizeEngineId } from '@/utils/engineDisplay'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { dialogStorageService } from '@/services/dialogStorage'

const log = createLogger('EventHandler')

function parseArtifactPreview(result: unknown): ArtifactPreviewBlock | null {
  const raw = typeof result === 'string'
    ? result
    : result && typeof result === 'object'
      ? JSON.stringify(result)
      : ''
  if (!raw.includes('"artifactType"') && !raw.includes('"artifact_type"')) return null

  const candidates: string[] = []
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i)
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  candidates.push(raw.trim())

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const artifactType = parsed.artifactType ?? parsed.artifact_type
      const contentType = parsed.contentType ?? parsed.content_type
      const previewId = parsed.previewId ?? parsed.preview_id
      if (
        artifactType !== 'polaris.preview' ||
        contentType !== 'html' ||
        typeof previewId !== 'string' ||
        typeof parsed.html !== 'string'
      ) {
        continue
      }

      return {
        type: 'artifact_preview',
        previewId,
        title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : 'PRD Prototype',
        contentType: 'html',
        html: parsed.html,
        sourcePath: typeof parsed.sourcePath === 'string'
          ? parsed.sourcePath
          : typeof parsed.source_path === 'string'
            ? parsed.source_path
            : undefined,
      }
    } catch {
      continue
    }
  }

  return null
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
      log.info('Session started', { sessionId: event.sessionId })
      break

    case 'session_end': {
      const completedMessage = state.finishMessage()
      set({
        isStreaming: false,
        progressMessage: null,
      })
      // 语音提醒：AI 回复自动朗读
      if (completedMessage) {
        // 检查是否为语音输入触发的对话
        const { inputWasVoice, setInputWasVoice } = useSessionStore.getState()
        // force: true = 语音输入强制播放, false = 键盘输入不播放
        voiceNotificationService.speakAIResponse(completedMessage, { force: inputWasVoice })
        // 重置语音输入标记
        if (inputWasVoice) {
          setInputWasVoice(false)
        }
      }

      // 保存到自有 JSONL 存储（整体覆写，幂等保序）
      // 必须用 get() 取 finishMessage() 之后的最新 state，否则会丢失最后一条 AI 回复
      saveDialog(get())

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

      const artifact = event.success ? parseArtifactPreview(event.result) : null
      if (artifact) {
        state.appendArtifactPreviewBlock(artifact)
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

    // permission_result is handled via plan_approval_result
    // there is no separate permission_result event type

    case 'question':
      state.appendQuestionBlock(
        event.questionId,
        event.header,
        event.options,
        event.multiSelect,
        event.allowCustomInput,
        event.categoryLabel,
      )
      break

    case 'question_answered':
      // QuestionAnsweredEvent has selected and customInput directly
      state.updateQuestionBlock(event.questionId, {
        selected: event.selected,
        customInput: event.customInput,
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
}

/**
 * 保存会话到自有 JSONL 存储
 *
 * 在 session_end 时整体覆写该会话文件（一个会话一个 .jsonl）。
 * 整存整取 → 幂等、保序、不重复，根治 IndexedDB 方案的消息错乱。
 * 完整序列化 ChatMessage（含 blocks/附件）→ 恢复时无损还原。
 */
async function saveDialog(state: ConversationStore): Promise<void> {
  try {
    const { conversationId, sessionId } = state
    if (!conversationId) return
    // store 中离屏消息可能已被压缩，持久化前必须恢复为完整态，
    // 否则压缩态（output 清空 / content 截断）会被写入 JSONL 永久丢失内容。
    const messages = state.getPersistableMessages()
    if (messages.length === 0) return

    // 会话元数据
    const metadata = sessionStoreManager.getState().sessionMetadata.get(sessionId)
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

    await dialogStorageService.saveConversation({
      externalId: conversationId,
      engineId,
      title,
      workspaceId: metadata?.workspaceId ?? null,
      workspacePath,
      messages,
    })

    log.info('会话已保存到 JSONL', { conversationId, messageCount: messages.length })
  } catch (e) {
    log.error('保存会话到 JSONL 失败', e instanceof Error ? e : new Error(String(e)))
  }
}

