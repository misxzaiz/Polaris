/**
 * EventChatStore 工具函数
 *
 * 包含事件处理、文件读取缓存等核心逻辑
 */

import { invoke } from '@tauri-apps/api/core'
import type { AIEvent } from '../../ai-runtime'
import type { EventChatState } from './types'
import { extractEditDiff, isEditTool } from '../../utils/diffExtractor'
import { registerPendingPlan } from '../../services/tauri'

// ============================================================================
// 文件读取缓存
// ============================================================================

/**
 * 文件读取缓存 - 避免同一文件重复读取
 * 用于 Edit 工具的异步读取优化
 */
const fileReadPromises = new Map<string, Promise<string>>()

/**
 * 带缓存的文件读取函数
 * 如果同一文件正在读取，返回现有 Promise，避免重复请求
 */
export function readFileWithCache(filePath: string): Promise<string> {
  // 如果正在读取，返回现有 Promise
  if (fileReadPromises.has(filePath)) {
    return fileReadPromises.get(filePath)!
  }

  // 创建新的读取 Promise
  const promise = invoke<string>('read_file_absolute', { path: filePath })
    .finally(() => {
      // 读取完成后清理缓存
      fileReadPromises.delete(filePath)
    })

  fileReadPromises.set(filePath, promise)
  return promise
}

/**
 * 清理文件读取缓存
 */
export function clearFileReadCache(): void {
  fileReadPromises.clear()
}

// ============================================================================
// AIEvent 处理器
// ============================================================================

/**
 * 处理 AIEvent 更新本地状态
 *
 * 这是统一的状态更新入口，所有 AIEvent 都通过这里更新本地状态。
 * 与 convertStreamEventToAIEvents() 配合使用，实现事件流统一处理。
 *
 * 设计说明：
 * - 只处理与本地状态相关的 AIEvent
 * - 不再直接处理 StreamEvent，避免重复逻辑
 * - 与 EventBus 分离，Store 只负责状态管理
 * - 使用依赖注入模式，通过 state 获取外部依赖
 *
 * @param event 要处理的 AIEvent
 * @param storeSet Zustand 的 set 函数
 * @param storeGet Zustand 的 get 函数
 * @param workspacePath 工作区路径
 */
export function handleAIEvent(
  event: AIEvent,
  storeSet: (partial: Partial<EventChatState> | ((state: EventChatState) => Partial<EventChatState>)) => void,
  storeGet: () => EventChatState,
  workspacePath?: string
): void {
  // 强制诊断日志
  console.log('[handleAIEvent] 收到事件:', event.type, {
    hasToken: event.type === 'token',
    tokenLength: event.type === 'token' ? event.value?.length : 0,
    timestamp: new Date().toISOString()
  })

  const state = storeGet()
  const toolPanelActions = state.getToolPanelActions()
  const gitActions = state.getGitActions()

  switch (event.type) {
    case 'session_start':
      storeSet({ conversationId: event.sessionId, isStreaming: true })
      console.log('[EventChatStore] Session started:', event.sessionId)
      if (toolPanelActions) {
        toolPanelActions.clearTools()
      }
      break

    case 'session_end':
      state.finishMessage()
      storeSet({ isStreaming: false, progressMessage: null })
      console.log('[EventChatStore] Session ended:', event.reason)

      // 会话结束时刷新 Git 状态（防抖）
      if (workspacePath && gitActions) {
        gitActions.refreshStatusDebounced(workspacePath).catch(err => {
          console.warn('[EventChatStore] 会话结束时刷新 Git 状态失败:', err)
        })
      }
      break

    case 'token':
      state.appendTextBlock(event.value)
      break

    case 'thinking':
      state.appendThinkingBlock(event.content)
      break

    case 'assistant_message':
      state.appendTextBlock(event.content)
      // 注意：工具调用会通过独立的 tool_call_start 事件处理，不在这里处理
      break

    case 'tool_call_start': {
      const toolName = event.tool
      const callId = event.callId || crypto.randomUUID()

      // 检测是否为 AskUserQuestion 工具
      if (toolName === 'ask_user_question' || toolName === 'AskUserQuestion') {
        // 兼容不同引擎的事件格式：某些引擎（如 IFlow CLI）使用 input 字段，某些使用 args 字段
        const args = event.args as Record<string, unknown>
        const input = (event as unknown as Record<string, unknown>).input as Record<string, unknown> | undefined
        // 优先使用 input 字段，如果为空则使用 args 字段
        const params = input && Object.keys(input).length > 0 ? input : args

        // 支持两种数据格式：
        // 格式1：直接在 params 中（旧格式）- header/options/multiSelect 等
        // 格式2：在 params.questions 数组中（新格式 IFlow CLI）
        let questionData: Record<string, unknown> = params
        let isNewFormat = false // 标记是否为新格式
        if (Array.isArray(params.questions) && params.questions.length > 0) {
          // 新格式：questions 数组，取第一个问题
          questionData = params.questions[0] as Record<string, unknown>
          isNewFormat = true
        }

        // 问题文本：优先使用 question 字段，其次是 header（作为问题文本），最后是 message
        // 注意：在新格式中，header 是类别标签，question 才是真正的问题文本
        const questionText = String(
          questionData.question ||
          questionData.header ||
          params.header ||
          params.question ||
          params.message ||
          '请选择：'
        )
        // 类别标签（可选）：只有在新格式中才设置，因为旧格式的 header 已经作为问题文本使用了
        const categoryLabel = isNewFormat && questionData.header ? String(questionData.header) : undefined

        // 解析选项：支持多种格式
        const rawOptions = questionData.options as Array<Record<string, unknown>> | string[] | undefined
        const options = Array.isArray(rawOptions)
          ? rawOptions.map(opt => {
              if (typeof opt === 'string') {
                return { value: opt, label: opt }
              }
              // 新格式：选项有 label、description、preview 字段
              // 使用 label 作为 value（如果没有显式的 value）
              return {
                value: String(opt.value || opt.label || ''),
                label: String(opt.label || opt.value || ''),
                description: opt.description ? String(opt.description) : undefined,
                preview: opt.preview ? String(opt.preview) : undefined,
              }
            })
          : []

        const multiSelect = Boolean(questionData.multiSelect || questionData.multi_select || params.multiSelect)
        const allowCustomInput = Boolean(
          questionData.allowCustomInput ||
          questionData.allow_custom_input ||
          questionData.allowInput ||
          params.allowCustomInput
        )

        state.appendQuestionBlock(
          callId,
          questionText,
          options,
          multiSelect,
          allowCustomInput,
          categoryLabel
        )

        // 同步注册到后端（用于 CLI stdin 输入等场景）
        const conversationId = storeGet().conversationId
        if (conversationId) {
          invoke('register_pending_question', {
            sessionId: conversationId,
            callId,
            header: questionText,
            multiSelect,
            options,
            allowCustomInput,
          }).catch(err => {
            console.warn('[EventChatStore] 注册待回答问题失败:', err)
          })
        }
        break
      }

      state.appendToolCallBlock(
        callId,
        toolName,
        event.args
      )

      // 对 Edit 工具，在执行前读取完整文件内容
      if (isEditTool(event.tool)) {
        const args = event.args as Record<string, unknown>
        const filePath = (args.file_path || args.path || args.filePath) as string

        if (filePath) {
          const callId = event.callId || crypto.randomUUID()

          // 修复：使用缓存的读取函数，避免重复读取
          readFileWithCache(filePath)
            .then(fullContent => {
              // 存储完整内容到 block
              const blockIndex = storeGet().toolBlockMap.get(callId)
              if (blockIndex !== undefined) {
                storeGet().updateToolCallBlockFullContent(
                  callId,
                  fullContent
                )
              }
            })
            .catch(err => {
              console.warn('[EventChatStore] 读取文件内容失败:', err)
            })
        }
      }
      break
    }

    case 'tool_call_end': {
      if (!event.callId) {
        console.warn('[EventChatStore] tool_call_end 事件缺少 callId，工具状态无法更新:', event.tool)
        break
      }

      // 检查是否为 AskUserQuestion 工具
      const questionBlockIndex = storeGet().questionBlockMap.get(event.callId)
      if (questionBlockIndex !== undefined) {
        // AskUserQuestion 工具结束，如果还没有答案则从 result 提取
        const questionBlock = storeGet().currentMessage?.blocks[questionBlockIndex]
        if (questionBlock?.type === 'question' && !questionBlock.answer) {
          // 尝试从 result 提取答案（如果后端返回了）
          const result = event.result as Record<string, unknown> | undefined
          if (result) {
            const selected = result.selected as string[] | undefined
            const customInput = result.customInput as string | undefined
            if (selected || customInput) {
              state.updateQuestionBlock(event.callId, {
                selected: selected || [],
                customInput,
              })
            }
          }
        }
        // AskUserQuestion 不需要走 tool_call 流程
        break
      }

      state.updateToolCallBlock(
        event.callId,
        event.success ? 'completed' : 'failed',
        String(event.result || '')
      )

      // 对 Edit 工具，提取 Diff 数据
      // 修复：不使用 event.tool 判断，而是在获取 block 后用 block.name 判断
      if (event.success) {
        const currentState = storeGet()
        const blockIndex = currentState.toolBlockMap.get(event.callId)

        if (currentState.currentMessage && blockIndex !== undefined) {
          const block = currentState.currentMessage.blocks[blockIndex]

          if (block && block.type === 'tool_call' && isEditTool(block.name)) {
            const diffData = extractEditDiff(block)
            if (diffData) {
              currentState.updateToolCallBlockDiff(event.callId, diffData)

              // 修复：降级策略也使用缓存读取，避免重复请求
              if (!block.diffData?.fullOldContent && diffData.filePath) {
                // 捕获 callId，避免异步回调中的类型问题
                const callId = event.callId
                readFileWithCache(diffData.filePath)
                  .then(fullContent => {
                    // 再次检查是否还需要设置（避免竞态）
                    const checkState = storeGet()
                    const blockIdx = checkState.toolBlockMap.get(callId)
                    if (blockIdx !== undefined) {
                      const currentBlock = checkState.currentMessage?.blocks[blockIdx]
                      if (currentBlock?.type === 'tool_call' && !currentBlock.diffData?.fullOldContent) {
                        console.log('[EventChatStore] 降级策略：从文件系统读取完整内容')
                        checkState.updateToolCallBlockFullContent(callId, fullContent)
                      }
                    }
                  })
                  .catch(err => {
                    console.warn('[EventChatStore] 降级读取失败，无法读取文件内容:', err)
                    // 标记为无法精确撤销
                    storeGet().updateToolCallBlockFullContent(callId, '')
                  })
              }
            }
          }
        }
      }

      // 工具完成后刷新 Git 状态（防抖）
      if (workspacePath && gitActions) {
        gitActions.refreshStatusDebounced(workspacePath).catch(err => {
          console.warn('[EventChatStore] 工具完成后刷新 Git 状态失败:', err)
        })
      }
      break
    }

    case 'progress':
      storeSet({ progressMessage: event.message || null })
      break

    case 'error':
      state.finishMessage()
      storeSet({ error: event.error, isStreaming: false })
      break

    case 'user_message':
      // 用户消息由 sendMessage 直接添加，这里不需要处理
      break

    case 'question_answered': {
      // 处理问题已回答事件（来自后端）
      const questionEvent = event as { callId: string; answer: { selected: string[]; customInput?: string } }
      state.updateQuestionBlock(questionEvent.callId, questionEvent.answer)
      console.log('[EventChatStore] Question answered:', questionEvent.callId)
      break
    }

    // ========================================
    // PlanMode 事件处理
    // ========================================

    case 'plan_start': {
      // 计划开始：创建新的 PlanModeBlock
      const planEvent = event as { sessionId: string; planId: string }
      state.appendPlanModeBlock(
        planEvent.planId,
        planEvent.sessionId
      )
      console.log('[EventChatStore] Plan started:', planEvent.planId)
      break
    }

    case 'plan_content': {
      // 计划内容：更新完整的计划内容
      const planEvent = event as {
        sessionId: string
        planId: string
        title?: string
        description?: string
        stages: Array<{
          stageId: string
          name: string
          description?: string
          status: 'pending' | 'in_progress' | 'completed' | 'failed'
          tasks: Array<{
            taskId: string
            description: string
            status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
          }>
        }>
        status: string
      }

      state.updatePlanModeBlock(planEvent.planId, {
        title: planEvent.title,
        description: planEvent.description,
        stages: planEvent.stages,
        status: planEvent.status as 'drafting' | 'pending_approval' | 'approved' | 'rejected' | 'executing' | 'completed' | 'canceled',
      })
      console.log('[EventChatStore] Plan content updated:', planEvent.planId, 'stages:', planEvent.stages?.length)
      break
    }

    case 'plan_stage_update': {
      // 阶段更新：更新单个阶段的状态
      const planEvent = event as {
        sessionId: string
        planId: string
        stageId: string
        status: 'pending' | 'in_progress' | 'completed' | 'failed'
        tasks?: Array<{
          taskId: string
          description: string
          status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
        }>
      }

      state.updatePlanStageStatus(
        planEvent.planId,
        planEvent.stageId,
        planEvent.status,
        planEvent.tasks
      )
      console.log('[EventChatStore] Plan stage updated:', planEvent.stageId, 'status:', planEvent.status)
      break
    }

    case 'plan_approval_request': {
      // 审批请求：标记计划为等待审批
      const planEvent = event as { sessionId: string; planId: string; message?: string }

      state.updatePlanModeBlock(planEvent.planId, {
        status: 'pending_approval',
        isActive: true,
      })

      // 注册待审批计划到后端
      // planBlockMap 存储的是 blockIndex，需要先获取 index 再获取实际的 block
      const blockIndex = state.planBlockMap.get(planEvent.planId)
      const planBlock = blockIndex !== undefined && state.currentMessage
        ? state.currentMessage.blocks[blockIndex]
        : undefined

      // 类型守卫检查是否为 PlanModeBlock
      const title = planBlock && 'title' in planBlock ? planBlock.title : undefined
      const description = planBlock && 'description' in planBlock ? planBlock.description : undefined

      registerPendingPlan(
        planEvent.sessionId,
        planEvent.planId,
        title,
        description
      ).catch(err => {
        console.error('[EventChatStore] Failed to register pending plan:', err)
      })

      console.log('[EventChatStore] Plan approval requested:', planEvent.planId)
      break
    }

    case 'plan_approval_result': {
      // 审批结果：更新计划的审批状态
      const planEvent = event as {
        sessionId: string
        planId: string
        approved: boolean
        feedback?: string
      }

      state.updatePlanModeBlock(planEvent.planId, {
        status: planEvent.approved ? 'approved' : 'rejected',
        feedback: planEvent.feedback,
        isActive: !planEvent.approved, // 拒绝时保持激活，允许修改
      })
      console.log('[EventChatStore] Plan approval result:', planEvent.planId, 'approved:', planEvent.approved)
      break
    }

    case 'plan_end': {
      // 计划结束：标记计划为完成/取消/拒绝
      const planEvent = event as {
        sessionId: string
        planId: string
        status: 'completed' | 'canceled' | 'rejected'
        reason?: string
      }

      state.updatePlanModeBlock(planEvent.planId, {
        status: planEvent.status,
        isActive: false,
      })

      // 清除活跃计划
      storeSet({ activePlanId: null })
      console.log('[EventChatStore] Plan ended:', planEvent.planId, 'status:', planEvent.status)
      break
    }

    // ========================================
    // AgentRun (Task) 事件处理
    // ========================================

    case 'task_metadata': {
      // 任务元数据：创建 AgentRunBlock
      const taskEvent = event as {
        taskId: string
        status: string
        startTime?: number
        endTime?: number
        duration?: number
        error?: string
      }

      // 只在任务开始时创建 AgentRunBlock
      if (taskEvent.status === 'pending' || taskEvent.status === 'running') {
        state.appendAgentRunBlock(
          taskEvent.taskId,
          'Agent', // 默认 Agent 类型
          undefined
        )
        console.log('[EventChatStore] AgentRun started:', taskEvent.taskId)
      }
      break
    }

    case 'task_progress': {
      // 任务进度：更新 AgentRunBlock 的进度信息
      const taskEvent = event as {
        taskId: string
        message?: string
        percent?: number
      }

      state.updateAgentRunBlock(taskEvent.taskId, {
        progressMessage: taskEvent.message,
        progressPercent: taskEvent.percent,
      })
      break
    }

    case 'task_completed': {
      // 任务完成：更新 AgentRunBlock 状态
      const taskEvent = event as {
        taskId: string
        status: 'success' | 'error' | 'canceled'
        duration?: number
        error?: string
      }

      state.updateAgentRunBlock(taskEvent.taskId, {
        status: taskEvent.status === 'success' ? 'success' :
                taskEvent.status === 'error' ? 'error' : 'canceled',
        duration: taskEvent.duration,
        error: taskEvent.error,
        completedAt: new Date().toISOString(),
      })

      // 清除活跃任务
      if (storeGet().activeTaskId === taskEvent.taskId) {
        storeSet({ activeTaskId: null })
      }
      console.log('[EventChatStore] AgentRun completed:', taskEvent.taskId, 'status:', taskEvent.status)
      break
    }

    case 'task_canceled': {
      // 任务取消：更新 AgentRunBlock 状态
      const taskEvent = event as {
        taskId: string
        reason?: string
      }

      state.updateAgentRunBlock(taskEvent.taskId, {
        status: 'canceled',
        error: taskEvent.reason,
        completedAt: new Date().toISOString(),
      })

      // 清除活跃任务
      if (storeGet().activeTaskId === taskEvent.taskId) {
        storeSet({ activeTaskId: null })
      }
      console.log('[EventChatStore] AgentRun canceled:', taskEvent.taskId)
      break
    }

    default:
      console.log('[EventChatStore] 未处理的 AIEvent 类型:', (event as { type: string }).type)
  }
}
