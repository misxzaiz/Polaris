/**
 * AI 事件处理器
 *
 * 处理单个会话的 AI 事件，所有事件都应该已经包含 sessionId
 */

import type { AIEvent } from '../../ai-runtime'
import type { ConversationStore } from './types'

/**
 * 处理单个会话的 AI 事件
 */
export function handleAIEvent(
  event: AIEvent,
  set: (partial: Partial<ConversationStore>) => void,
  get: () => ConversationStore
): void {
  const state = get()

  switch (event.type) {
    case 'session_start':
      set({
        conversationId: event.sessionId,
        isStreaming: true,
        error: null,
      })
      console.log('[ConversationStore] Session started:', event.sessionId)
      break

    case 'session_end':
      state.finishMessage()
      set({
        isStreaming: false,
        progressMessage: null,
      })
      console.log('[ConversationStore] Session ended:', {
        sessionId: state.sessionId,
        reason: event.reason,
        isStreaming: false,
      })
      break

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
      const callId = event.callId || crypto.randomUUID()
      state.appendToolCallBlock(callId, toolName, event.args)
      break
    }

    case 'tool_call_end': {
      const callId = event.callId || ''
      state.updateToolCallBlock(
        callId,
        event.success ? 'completed' : 'failed',
        event.result ? JSON.stringify(event.result, null, 2) : undefined
      )
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
        undefined  // description from plan_content event
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
        }
      )
      break

    case 'plan_stage_update':
      state.updatePlanStageStatus(
        event.planId,
        event.stageId,
        event.status,
        event.tasks
      )
      break

    case 'plan_approval_request':
      state.appendPermissionRequestBlock(
        event.planId,
        event.sessionId,
        [] // approval denials
      )
      break

    case 'plan_approval_result':
      state.updatePermissionRequestBlock(
        event.planId,
        event.approved ? 'approved' : 'denied'
      )
      break

    case 'plan_end':
      state.setActivePlan(null)
      break

    case 'agent_run_start':
      state.appendAgentRunBlock(
        event.taskId,
        event.agentType,
        event.capabilities
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
        event.denials
      )
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
        event.categoryLabel
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
      console.warn('[ConversationStore] 未处理的事件类型:', (_exhaustive as { type: string }).type)
    }
  }
}