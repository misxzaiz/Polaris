import { generateUUID } from '@/utils/uuid';
/**
 * ConversationStore 工厂函数
 *
 * 每个会话创建独立的 Store 实例
 */

import { create, StoreApi, UseBoundStore } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { invoke } from '@/services/tauri'
import type { ConversationStore, ConversationState, StoreDeps } from './types'
import type { ContentBlock, EngineId } from '@/types'
import type { AISession } from '@/ai-runtime'
import { handleAIEvent } from './eventHandler'
import { runAgnesImageGeneration } from './agnesRunner'
import { sessionStoreManager } from './sessionStoreManager'
import { parseWorkspaceReferences } from '@/services/workspaceReference'
import i18n from 'i18next'
import { MessageCompactor, isCompacted } from '@/utils/messageCompactor'
import { isEditTool, extractEditDiff } from '@/utils/diffExtractor'
import { getSessionConfig } from '../sessionConfigStore'
import { getActiveModelProfile } from '../modelProfileStore'
import { createLogger } from '@/utils/logger'
import {
  resolveSessionEngine,
  resolveRuntimeConfigForEngine,
  getDisabledPluginMcpServers,
  hydrateFromLocalStorage,
  generateTitleFromMessage,
  buildWorkspacePrompts,
  normalizeForInvoke,
  resolveChatError,
  resolveEffectiveProfileId,
} from './conversationStoreUtils'

const log = createLogger('ConversationStore')

/**
 * ConversationStore 实例类型（包含 getState 方法）
 */
export type ConversationStoreInstance = UseBoundStore<StoreApi<ConversationStore>>

/**
 * 初始状态工厂
 */
function createInitialState(sessionId: string): ConversationState {
  return {
    // 消息状态
    messages: [],
    archivedMessages: [],
    currentMessage: null,

    // 流式构建映射
    toolBlockMap: new Map(),
    questionBlockMap: new Map(),
    planBlockMap: new Map(),
    activePlanId: null,
    agentRunBlockMap: new Map(),
    activeTaskId: null,
    toolGroupBlockMap: new Map(),
    pendingToolGroup: null,
    permissionRequestBlockMap: new Map(),
    activePermissionRequestId: null,
    mediaBlockMap: new Map(),
    streamingUpdateCounter: 0,

    // 会话状态
    conversationId: null,
    currentConversationSeed: null,
    isStreaming: false,
    error: null,
    progressMessage: null,
    promptSuggestion: null,

    // 输入草稿
    inputDraft: {
      text: '',
      attachments: [],
    },

    // 工作区关联
    workspaceId: null,

    // 可见区域追踪
    visibleRange: null,

    // 元数据
    sessionId,
  }
}

/**
 * 创建单个会话的 Store 实例
 *
 * 每个会话独立拥有：
 * - 消息状态和操作方法
 * - 流式构建状态
 * - 会话 ID 和错误状态
 * - 事件处理能力
 *
 * @param sessionId 会话唯一标识（前端生成）
 * @param deps 外部依赖注入
 */
export function createConversationStore(
  sessionId: string,
  deps: StoreDeps
): ConversationStoreInstance {
  const initialState = createInitialState(sessionId)

  const getCurrentEngineId = (): EngineId => {
    return resolveSessionEngine(sessionId, deps.getConfig()?.defaultEngine)
  }

  const createCurrentAssistantMessage = (blocks: ContentBlock[]) => ({
    id: generateUUID(),
    engineId: getCurrentEngineId(),
    blocks,
    isStreaming: true as const,
  })

  // ===== 流式文本缓冲区 =====
  // 段落级缓冲策略：
  // 1. 首段立即显示（快速响应）
  // 2. 后续段落等待 \n\n（段落结束）才 flush
  // 3. 超时保护：200ms 内没有段落结束也 flush
  let _textBuffer = ''
  let _paragraphTimer: ReturnType<typeof setTimeout> | null = null
  // 当前活跃的 Agnes 前端会话（仅 agnes 引擎使用，用于 interrupt 中止）
  let _agnesSession: AISession | null = null
  // 上一次压缩操作的可见范围，用于防止反馈循环（压缩→高度变化→新 range→再压缩）
  let _lastCompactionRange: { start: number; end: number } | null = null
  const PARAGRAPH_TIMEOUT = 200 // ms，超时保护

  // ===== 消息压缩器 =====
  // 模块级实例，管理消息快照的 LRU 缓存
  // 不放入 Zustand state（内部可变状态，不需要触发渲染）
  const compactor = new MessageCompactor()

  const store = create<ConversationStore>()(
    subscribeWithSelector((set, get) => ({
      ...initialState,

      // ===== 消息操作 =====
      addMessage: (message) => {
        set((state) => {
          const newMessages = [...state.messages, message]
          return { messages: newMessages }
        })
      },

      deleteMessage: (messageId) => {
        set((state) => {
          const newMessages = state.messages.filter((m) => m.id !== messageId)
          return { messages: newMessages }
        })
      },

      editMessage: (messageId, newContent) => {
        set((state) => {
          const newMessages = state.messages.map((m) =>
            m.id === messageId && m.type === 'user' ? { ...m, content: newContent } : m
          )
          return { messages: newMessages }
        })
      },

      clearMessages: () => {
        set({
          messages: [],
          archivedMessages: [],
          currentMessage: null,
          toolBlockMap: new Map(),
          questionBlockMap: new Map(),
          planBlockMap: new Map(),
          activePlanId: null,
          agentRunBlockMap: new Map(),
          activeTaskId: null,
          toolGroupBlockMap: new Map(),
          pendingToolGroup: null,
          permissionRequestBlockMap: new Map(),
          activePermissionRequestId: null,
          mediaBlockMap: new Map(),
        })
      },

      finishMessage: () => {
        // 先 flush 所有缓冲的文本
        if (_textBuffer) get()._flushTextBuffer()

        // 清除定时器
        if (_paragraphTimer) {
          clearTimeout(_paragraphTimer)
          _paragraphTimer = null
        }

        const { currentMessage, messages } = get()
        if (currentMessage) {
          const completedMessage = {
            id: currentMessage.id,
            type: 'assistant' as const,
            engineId: currentMessage.engineId,
            blocks: currentMessage.blocks,
            timestamp: new Date().toISOString(),
            isStreaming: false,
          }
          set({
            messages: [...messages, completedMessage],
            currentMessage: null,
          })
          return completedMessage
        }
        return null
      },

      // ===== 输入草稿 =====
      updateInputDraft: (draft) => {
        set({ inputDraft: draft })
      },

      clearInputDraft: () => {
        set({
          inputDraft: {
            text: '',
            attachments: [],
          },
        })
      },

      // ===== 流式构建 =====
      // 段落级缓冲策略：
      // 1. 首次创建消息时立即 flush（保证首 token 响应速度）
      // 2. 后续更新等待 \n\n（段落结束）才 flush
      // 3. 超时保护：200ms 内没有段落结束也 flush
      // 效果：渲染更像"事件级"，一个段落一次渲染，减少视觉跳动
      appendTextBlock: (content) => {
        // 追加到闭包级 buffer（O(1），不触发 Zustand）
        _textBuffer += content

        const state = get()

        // 首次创建消息时立即 flush（保证首 token 响应速度）
        if (!state.currentMessage) {
          // 防御：session_end 已到达但迟到的 token 仍在写入
          // 此时 isStreaming=false 且 currentMessage=null，说明 finishMessage 已执行
          // 迟到的内容应追加到最后一条助手消息，而非创建孤儿消息
          if (!state.isStreaming) {
            const bufferContent = _textBuffer
            _textBuffer = ''
            if (bufferContent) {
              const { messages } = get()
              const lastIdx = messages.length - 1
              if (lastIdx >= 0 && messages[lastIdx].type === 'assistant') {
                const lastMsg = messages[lastIdx]
                const blocks = [...lastMsg.blocks]
                const lastBlock = blocks[blocks.length - 1]
                if (lastBlock?.type === 'text') {
                  blocks[blocks.length - 1] = { ...lastBlock, content: lastBlock.content + bufferContent }
                } else {
                  blocks.push({ type: 'text', content: bufferContent })
                }
                const newMessages = [...messages]
                newMessages[lastIdx] = { ...lastMsg, blocks }
                set({ messages: newMessages })
              }
            }
            return
          }
          get()._flushTextBuffer()
          return
        }

        // 段落级模式：检测缓冲区中的段落结束
        // 注意：需要检查 _textBuffer 而非 content，因为 \n\n 可能跨两个 token
        if (_textBuffer.includes('\n\n')) {
          // 段落结束，立即 flush
          if (_paragraphTimer) {
            clearTimeout(_paragraphTimer)
            _paragraphTimer = null
          }
          get()._flushTextBuffer()
        } else if (!_paragraphTimer) {
          // 启动超时保护定时器
          _paragraphTimer = setTimeout(() => {
            _paragraphTimer = null
            get()._flushTextBuffer()
          }, PARAGRAPH_TIMEOUT)
        }
      },

      /** 内部方法：将缓冲区文本 flush 到 Zustand store */
      _flushTextBuffer: () => {
        // 清除超时定时器
        if (_paragraphTimer) {
          clearTimeout(_paragraphTimer)
          _paragraphTimer = null
        }

        // 取出缓冲区内容并重置
        const bufferToFlush = _textBuffer
        _textBuffer = ''

        const state = get()
        if (!bufferToFlush && state.currentMessage) return

        if (!state.currentMessage) {
          if (bufferToFlush) {
            if (!state.isStreaming) {
              // session_end 已到达，定时器 flush 的迟到内容追加到最后一条消息
              const { messages } = get()
              const lastIdx = messages.length - 1
              if (lastIdx >= 0 && messages[lastIdx].type === 'assistant') {
                const lastMsg = messages[lastIdx]
                const blocks = [...lastMsg.blocks]
                const lastBlock = blocks[blocks.length - 1]
                if (lastBlock?.type === 'text') {
                  blocks[blocks.length - 1] = { ...lastBlock, content: lastBlock.content + bufferToFlush }
                } else {
                  blocks.push({ type: 'text', content: bufferToFlush })
                }
                const newMessages = [...messages]
                newMessages[lastIdx] = { ...lastMsg, blocks }
                set({ messages: newMessages })
              }
            } else {
              // 首次创建消息
              set({
                currentMessage: createCurrentAssistantMessage([{ type: 'text', content: bufferToFlush }]),
                streamingUpdateCounter: state.streamingUpdateCounter + 1,
              })
            }
          }
        } else {
          // 更新最后一个文本块
          const blocks = [...state.currentMessage.blocks]
          const lastBlock = blocks[blocks.length - 1]
          if (lastBlock?.type === 'text') {
            blocks[blocks.length - 1] = { ...lastBlock, content: lastBlock.content + bufferToFlush }
          } else if (bufferToFlush) {
            blocks.push({ type: 'text', content: bufferToFlush })
          }
          set({
            currentMessage: { ...state.currentMessage, blocks },
            streamingUpdateCounter: state.streamingUpdateCounter + 1,
          })
        }

        // 段落级策略：不需要自动重新调度
        // flush 时机由 appendTextBlock 中的段落检测 (\n\n) 或超时保护触发
      },

      appendThinkingBlock: (content) => {
        // 先 flush 文本缓冲区，确保文本不丢失
        if (_textBuffer) get()._flushTextBuffer()

        const { currentMessage, streamingUpdateCounter } = get()
        const block = { type: 'thinking' as const, content }
        if (!currentMessage) {
          set({
            currentMessage: createCurrentAssistantMessage([block]),
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        } else {
          const blocks = [...currentMessage.blocks]
          const lastBlock = blocks[blocks.length - 1]
          if (lastBlock?.type === 'thinking') {
            blocks[blocks.length - 1] = { ...lastBlock, content: lastBlock.content + content }
          } else {
            blocks.push(block)
          }
          set({
            currentMessage: { ...currentMessage, blocks },
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        }
      },

      appendToolCallBlock: (toolId, toolName, input) => {
        // 先 flush 文本缓冲区
        if (_textBuffer) get()._flushTextBuffer()

        const { currentMessage, toolBlockMap, streamingUpdateCounter } = get()
        const block = {
          type: 'tool_call' as const,
          id: toolId,
          name: toolName,
          input,
          status: 'running' as const,
          startedAt: new Date().toISOString(),
        }
        const newMap = new Map(toolBlockMap)
        if (!currentMessage) {
          newMap.set(toolId, 0)
          set({
            currentMessage: createCurrentAssistantMessage([block]),
            toolBlockMap: newMap,
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        } else {
          const blocks = [...currentMessage.blocks, block]
          newMap.set(toolId, blocks.length - 1)
          set({
            currentMessage: { ...currentMessage, blocks },
            toolBlockMap: newMap,
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        }
      },

      updateToolCallBlock: (toolId, status, output?, error?) => {
        const { currentMessage, toolBlockMap } = get()
        if (!currentMessage) return
        const idx = toolBlockMap.get(toolId)
        if (idx === undefined) return
        const blocks = [...currentMessage.blocks]
        const block = blocks[idx]
        if (block?.type !== 'tool_call') return
        blocks[idx] = {
          ...block,
          status,
          output: output ?? block.output,
          error: error ?? block.error,
          completedAt: status === 'completed' || status === 'failed' ? new Date().toISOString() : block.completedAt,
        }
        set({ currentMessage: { ...currentMessage, blocks } })
      },

      appendMediaBlock: (taskId, mediaType, prompt) => {
        // 先 flush 文本缓冲区
        if (_textBuffer) get()._flushTextBuffer()

        const { currentMessage, mediaBlockMap, streamingUpdateCounter } = get()
        const block = {
          type: 'media' as const,
          id: taskId,
          mediaType,
          status: 'generating' as const,
          prompt,
          progress: 0,
          startedAt: new Date().toISOString(),
        }
        const newMap = new Map(mediaBlockMap)
        if (!currentMessage) {
          newMap.set(taskId, 0)
          set({
            currentMessage: createCurrentAssistantMessage([block]),
            mediaBlockMap: newMap,
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        } else {
          const blocks = [...currentMessage.blocks, block]
          newMap.set(taskId, blocks.length - 1)
          set({
            currentMessage: { ...currentMessage, blocks },
            mediaBlockMap: newMap,
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        }
      },

      updateMediaBlock: (taskId, patch) => {
        const { currentMessage, mediaBlockMap, streamingUpdateCounter } = get()
        if (!currentMessage) return
        const idx = mediaBlockMap.get(taskId)
        if (idx === undefined) return
        const blocks = [...currentMessage.blocks]
        const block = blocks[idx]
        if (block?.type !== 'media') return
        const nextStatus = patch.status ?? block.status
        blocks[idx] = {
          ...block,
          ...patch,
          completedAt:
            nextStatus === 'completed' || nextStatus === 'failed'
              ? new Date().toISOString()
              : block.completedAt,
        }
        set({
          currentMessage: { ...currentMessage, blocks },
          streamingUpdateCounter: streamingUpdateCounter + 1,
        })
      },

      updateToolCallBlockDiff: (toolId, diffData) => {
        const { currentMessage, toolBlockMap } = get()
        if (!currentMessage) return
        const idx = toolBlockMap.get(toolId)
        if (idx === undefined) return
        const blocks = [...currentMessage.blocks]
        if (blocks[idx]?.type === 'tool_call') {
          blocks[idx] = { ...blocks[idx], diffData }
          set({ currentMessage: { ...currentMessage, blocks } })
        }
      },


      updateCurrentAssistantMessage: (blocks) => {
        const { currentMessage } = get()
        if (currentMessage) {
          set({ currentMessage: { ...currentMessage, blocks } })
        }
      },

      // ===== 问题块 =====
      appendQuestionBlock: (questionId, header, options, multiSelect?, allowCustomInput?, categoryLabel?) => {
        const { currentMessage, questionBlockMap, streamingUpdateCounter } = get()
        const block = {
          type: 'question' as const,
          id: questionId,
          header,
          options,
          multiSelect: multiSelect ?? false,
          allowCustomInput: allowCustomInput ?? true,
          categoryLabel,
          status: 'pending' as const,
        }
        const newMap = new Map(questionBlockMap)
        if (!currentMessage) {
          newMap.set(questionId, 0)
          set({
            currentMessage: createCurrentAssistantMessage([block]),
            questionBlockMap: newMap,
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        } else {
          const blocks = [...currentMessage.blocks, block]
          newMap.set(questionId, blocks.length - 1)
          set({
            currentMessage: { ...currentMessage, blocks },
            questionBlockMap: newMap,
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        }
      },

      updateQuestionBlock: (questionId, answer) => {
        const { currentMessage, questionBlockMap } = get()
        if (!currentMessage) return
        const idx = questionBlockMap.get(questionId)
        if (idx === undefined) return
        const blocks = [...currentMessage.blocks]
        if (blocks[idx]?.type === 'question') {
          blocks[idx] = { ...blocks[idx], answer, status: 'answered' as const }
          set({ currentMessage: { ...currentMessage, blocks } })
        }
      },

      // ===== PlanMode =====
      appendPlanModeBlock: (planId, sessionId, title?, description?, stages?) => {
        const { currentMessage, planBlockMap, streamingUpdateCounter } = get()
        const block = {
          type: 'plan_mode' as const,
          id: planId,
          sessionId,
          title: title ?? '执行计划',
          description,
          stages: stages ?? [],
          status: 'drafting' as const,
        }
        const newMap = new Map(planBlockMap)
        if (!currentMessage) {
          newMap.set(planId, 0)
          set({
            currentMessage: createCurrentAssistantMessage([block]),
            planBlockMap: newMap,
            activePlanId: planId,
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        } else {
          const blocks = [...currentMessage.blocks, block]
          newMap.set(planId, blocks.length - 1)
          set({
            currentMessage: { ...currentMessage, blocks },
            planBlockMap: newMap,
            activePlanId: planId,
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        }
      },

      updatePlanModeBlock: (planId, updates) => {
        const { currentMessage, planBlockMap } = get()
        if (!currentMessage) return
        const idx = planBlockMap.get(planId)
        if (idx === undefined) return
        const blocks = [...currentMessage.blocks]
        if (blocks[idx]?.type === 'plan_mode') {
          blocks[idx] = { ...blocks[idx], ...updates }
          set({ currentMessage: { ...currentMessage, blocks } })
        }
      },

      updatePlanStageStatus: (planId, stageId, status, tasks?) => {
        const { currentMessage, planBlockMap } = get()
        if (!currentMessage) return
        const idx = planBlockMap.get(planId)
        if (idx === undefined) return
        const blocks = [...currentMessage.blocks]
        const block = blocks[idx]
        if (block?.type !== 'plan_mode') return
        const stages = block.stages?.map((s) => (s.stageId === stageId ? { ...s, status, tasks: tasks ?? s.tasks } : s))
        blocks[idx] = { ...block, stages }
        set({ currentMessage: { ...currentMessage, blocks } })
      },

      setActivePlan: (planId) => set({ activePlanId: planId }),

      // ===== AgentRun =====
      appendAgentRunBlock: (taskId, agentType, capabilities?) => {
        const { currentMessage, agentRunBlockMap, streamingUpdateCounter } = get()
        const block = {
          type: 'agent_run' as const,
          id: taskId,
          agentType,
          capabilities: capabilities ?? [],
          status: 'running' as const,
          toolCalls: [],
          startedAt: new Date().toISOString(),
        }
        const newMap = new Map(agentRunBlockMap)
        if (!currentMessage) {
          newMap.set(taskId, 0)
          set({
            currentMessage: createCurrentAssistantMessage([block]),
            agentRunBlockMap: newMap,
            activeTaskId: taskId,
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        } else {
          const blocks = [...currentMessage.blocks, block]
          newMap.set(taskId, blocks.length - 1)
          set({
            currentMessage: { ...currentMessage, blocks },
            agentRunBlockMap: newMap,
            activeTaskId: taskId,
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        }
      },

      updateAgentRunBlock: (taskId, updates) => {
        const { currentMessage, agentRunBlockMap } = get()
        if (!currentMessage) return
        const idx = agentRunBlockMap.get(taskId)
        if (idx === undefined) return
        const blocks = [...currentMessage.blocks]
        if (blocks[idx]?.type === 'agent_run') {
          blocks[idx] = { ...blocks[idx], ...updates }
          set({ currentMessage: { ...currentMessage, blocks } })
        }
      },

      appendAgentToolCall: (taskId, toolId, toolName) => {
        const { currentMessage, agentRunBlockMap } = get()
        if (!currentMessage) return
        const idx = agentRunBlockMap.get(taskId)
        if (idx === undefined) return
        const blocks = [...currentMessage.blocks]
        const block = blocks[idx]
        if (block?.type !== 'agent_run') return
        blocks[idx] = {
          ...block,
          toolCalls: [...(block.toolCalls ?? []), { id: toolId, name: toolName, status: 'running' as const }],
        }
        set({ currentMessage: { ...currentMessage, blocks } })
      },

      updateAgentToolCallStatus: (taskId, toolId, status, summary?) => {
        const { currentMessage, agentRunBlockMap } = get()
        if (!currentMessage) return
        const idx = agentRunBlockMap.get(taskId)
        if (idx === undefined) return
        const blocks = [...currentMessage.blocks]
        const block = blocks[idx]
        if (block?.type !== 'agent_run') return
        blocks[idx] = {
          ...block,
          toolCalls: block.toolCalls?.map((tc) =>
            tc.id === toolId ? { ...tc, status, summary } : tc
          ),
        }
        set({ currentMessage: { ...currentMessage, blocks } })
      },

      setActiveTask: (taskId) => set({ activeTaskId: taskId }),

      // ===== ToolGroup =====
      appendToolGroupBlock: (groupId, tools, summary) => {
        const { currentMessage, toolGroupBlockMap, streamingUpdateCounter } = get()
        const toolNames = tools.map(t => t.name)
        const block = {
          type: 'tool_group' as const,
          id: groupId,
          tools,
          toolNames,
          status: 'running' as const,
          summary,
          startedAt: new Date().toISOString(),
        }
        const newMap = new Map(toolGroupBlockMap)
        if (!currentMessage) {
          newMap.set(groupId, 0)
          set({
            currentMessage: createCurrentAssistantMessage([block]),
            toolGroupBlockMap: newMap,
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        } else {
          const blocks = [...currentMessage.blocks, block]
          newMap.set(groupId, blocks.length - 1)
          set({
            currentMessage: { ...currentMessage, blocks },
            toolGroupBlockMap: newMap,
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        }
      },

      updateToolGroupBlock: (groupId, updates) => {
        const { currentMessage, toolGroupBlockMap } = get()
        if (!currentMessage) return
        const idx = toolGroupBlockMap.get(groupId)
        if (idx === undefined) return
        const blocks = [...currentMessage.blocks]
        if (blocks[idx]?.type === 'tool_group') {
          blocks[idx] = { ...blocks[idx], ...updates }
          set({ currentMessage: { ...currentMessage, blocks } })
        }
      },

      updateToolInGroup: (groupId, toolId, updates) => {
        const { currentMessage, toolGroupBlockMap } = get()
        if (!currentMessage) return
        const idx = toolGroupBlockMap.get(groupId)
        if (idx === undefined) return
        const blocks = [...currentMessage.blocks]
        const block = blocks[idx]
        if (block?.type !== 'tool_group') return
        blocks[idx] = { ...block, tools: block.tools.map((t) => (t.id === toolId ? { ...t, ...updates } : t)) }
        set({ currentMessage: { ...currentMessage, blocks } })
      },

      setPendingToolGroup: (group) => set({ pendingToolGroup: group }),

      addToolToPendingGroup: (tool) => {
        const { pendingToolGroup } = get()
        if (!pendingToolGroup) return
        set({
          pendingToolGroup: {
            ...pendingToolGroup,
            tools: [...pendingToolGroup.tools, { ...tool, status: 'running' }],
            lastToolAt: Date.now(),
          },
        })
      },

      finalizePendingToolGroup: () => {
        const { pendingToolGroup, currentMessage, toolGroupBlockMap, streamingUpdateCounter } = get()
        if (!pendingToolGroup || !currentMessage) return
        const summary = `执行了 ${pendingToolGroup.tools.length} 个工具`
        const toolNames = pendingToolGroup.tools.map(t => t.name)
        const block = {
          type: 'tool_group' as const,
          id: pendingToolGroup.groupId,
          tools: pendingToolGroup.tools,
          toolNames,
          status: 'completed' as const,
          summary,
          startedAt: pendingToolGroup.tools[0]?.startedAt ?? new Date().toISOString(),
        }
        const newMap = new Map(toolGroupBlockMap)
        const blocks = [...currentMessage.blocks, block]
        newMap.set(pendingToolGroup.groupId, blocks.length - 1)
        set({
          currentMessage: { ...currentMessage, blocks },
          toolGroupBlockMap: newMap,
          pendingToolGroup: null,
          streamingUpdateCounter: streamingUpdateCounter + 1,
        })
      },

      // ===== PermissionRequest =====
      appendPermissionRequestBlock: (requestId, sessionId, denials) => {
        const { currentMessage, permissionRequestBlockMap, streamingUpdateCounter } = get()
        // 归一化每个 denial：兼容后端 flatten 的 snake_case（tool_input/tool_use_id），
        // 提取为 toolInput/toolUseId，并初始化逐项决策状态为 pending。
        // 空 denials（plan 审批复用此方法）天然为空数组，行为不变。
        const normalizedDenials = denials.map(d => {
          const raw = d as Record<string, unknown>
          return {
            toolName: d.toolName,
            reason: d.reason,
            toolInput: (d.toolInput ?? raw.tool_input) as Record<string, unknown> | undefined,
            toolUseId: (d.toolUseId ?? raw.tool_use_id) as string | undefined,
            status: 'pending' as const,
            extra: d.extra,
          }
        })
        const block = {
          type: 'permission_request' as const,
          id: requestId,
          sessionId,
          denials: normalizedDenials,
          status: 'pending' as const,
        }
        const newMap = new Map(permissionRequestBlockMap)
        if (!currentMessage) {
          newMap.set(requestId, 0)
          set({
            currentMessage: createCurrentAssistantMessage([block]),
            permissionRequestBlockMap: newMap,
            activePermissionRequestId: requestId,
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        } else {
          const blocks = [...currentMessage.blocks, block]
          newMap.set(requestId, blocks.length - 1)
          set({
            currentMessage: { ...currentMessage, blocks },
            permissionRequestBlockMap: newMap,
            activePermissionRequestId: requestId,
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        }
      },

      updatePermissionRequestBlock: (requestId, status, decision?) => {
        const { currentMessage, permissionRequestBlockMap } = get()
        if (!currentMessage) return
        const idx = permissionRequestBlockMap.get(requestId)
        if (idx === undefined) return
        const blocks = [...currentMessage.blocks]
        if (blocks[idx]?.type === 'permission_request') {
          blocks[idx] = { ...blocks[idx], status, decision }
          set({ currentMessage: { ...currentMessage, blocks }, activePermissionRequestId: status === 'pending' ? requestId : null })
        }
      },

      setActivePermissionRequest: (requestId) => set({ activePermissionRequestId: requestId }),

      resolvePermissionRequest: (requestId, perItem) => {
        // 逐项落库决策（status/scope），并据此推导整卡状态：任一批准→approved，否则 denied。
        // 同时扫描当前流式消息与已归档消息（块可能已被 session_end 归档），保证刷新/重载一致。
        const applyToBlocks = (blocks: import('../../types/chat').ContentBlock[]) => {
          let changed = false
          const next = blocks.map(b => {
            if (b.type === 'permission_request' && b.id === requestId && b.status === 'pending') {
              changed = true
              const denials = b.denials.map((d, i) => {
                const dec = perItem[i]
                return dec ? { ...d, status: dec.status, scope: dec.scope } : d
              })
              const anyApproved = denials.some(d => d.status === 'approved')
              return {
                ...b,
                denials,
                status: (anyApproved ? 'approved' : 'denied') as 'approved' | 'denied',
                decision: { approved: anyApproved, timestamp: new Date().toISOString() },
              }
            }
            return b
          })
          return changed ? next : null
        }

        const { currentMessage, messages } = get()
        const nextCurrent = currentMessage ? applyToBlocks(currentMessage.blocks) : null
        let messagesChanged = false
        const nextMessages = messages.map(m => {
          if (m.type === 'assistant' && m.blocks) {
            const nb = applyToBlocks(m.blocks)
            if (nb) { messagesChanged = true; return { ...m, blocks: nb } }
          }
          return m
        })

        if (nextCurrent || messagesChanged) {
          set({
            ...(nextCurrent && currentMessage ? { currentMessage: { ...currentMessage, blocks: nextCurrent } } : {}),
            ...(messagesChanged ? { messages: nextMessages } : {}),
            activePermissionRequestId: null,
          })
        }
      },

      expireStalePermissionRequests: () => {
        // 失效仍待处理的「工具权限请求」：仅 status==='pending' 且有真实 denials 的块。
        // 跳过 plan 审批复用的空 denials 块（不影响其原流程）。
        // 触发时机：用户发新消息 / 历史会话恢复——卡片绑定的后端等待点已不再有效。
        const expireInBlocks = (blocks: import('../../types/chat').ContentBlock[]) => {
          let changed = false
          const next = blocks.map(b => {
            if (b.type === 'permission_request' && b.status === 'pending' && b.denials.length > 0) {
              changed = true
              return { ...b, status: 'expired' as const }
            }
            return b
          })
          return changed ? next : null
        }

        const { currentMessage, messages } = get()
        const nextCurrent = currentMessage ? expireInBlocks(currentMessage.blocks) : null
        let messagesChanged = false
        const nextMessages = messages.map(m => {
          if (m.type === 'assistant' && m.blocks) {
            const nb = expireInBlocks(m.blocks)
            if (nb) { messagesChanged = true; return { ...m, blocks: nb } }
          }
          return m
        })

        if (nextCurrent || messagesChanged) {
          set({
            ...(nextCurrent && currentMessage ? { currentMessage: { ...currentMessage, blocks: nextCurrent } } : {}),
            ...(messagesChanged ? { messages: nextMessages } : {}),
            ...(get().activePermissionRequestId ? { activePermissionRequestId: null } : {}),
          })
        }
      },

      // ===== 会话控制 =====
      setConversationId: (id) => set({ conversationId: id }),
      setStreaming: (streaming) => set({ isStreaming: streaming }),
      setError: (error) => set({ error }),
      setProgressMessage: (message) => set({ progressMessage: message }),
      setPromptSuggestion: (suggestion) => set({ promptSuggestion: suggestion }),

      // ===== 历史恢复 =====
      setMessagesFromHistory: (messages, conversationId) => {
        // 清除旧会话的压缩快照，避免快照与消息不匹配
        compactor.clearSnapshots()
        _lastCompactionRange = null // 重置压缩范围，防止旧范围阻止新会话首次压缩

        // 为已完成的 Edit 工具回填 diffData（历史消息可能缺失）
        const processedMessages = messages.map(msg => {
          if (msg.type !== 'assistant' || !msg.blocks) return msg
          let modified = false
          const blocks = msg.blocks.map(block => {
            if (
              block.type === 'tool_call' &&
              block.status === 'completed' &&
              !block.diffData &&
              isEditTool(block.name)
            ) {
              const diff = extractEditDiff(block)
              if (diff) {
                modified = true
                return { ...block, diffData: diff }
              }
            }
            // 历史恢复：仍待处理的「工具权限请求」一律失效（后端那一轮已结束，不可再授权）。
            // 仅作用于有真实 denials 的块，跳过 plan 审批复用的空 denials 块。
            if (
              block.type === 'permission_request' &&
              block.status === 'pending' &&
              block.denials.length > 0
            ) {
              modified = true
              return { ...block, status: 'expired' as const }
            }
            return block
          })
          return modified ? { ...msg, blocks } : msg
        })

        set({
          messages: processedMessages,
          archivedMessages: [],
          conversationId,
          isStreaming: false,
          error: null,
          currentMessage: null,
          progressMessage: null,
          visibleRange: null,
        })
      },

      // ===== 事件处理 =====
      handleAIEvent: (event) => handleAIEvent(event, set, get),

      // ===== 主动操作 =====

      sendMessage: async (content, workspaceDir?, attachments?, sendOptions?) => {
        const { conversationId, sessionId, messages } = get()
        const config = deps.getConfig()
        const engine = resolveSessionEngine(sessionId, config?.defaultEngine)

        // 失效收口：用户发出新消息时，将仍待处理的工具权限请求标记为已失效
        // （卡片绑定上一轮后端等待点，新消息推进后不再可授权）。
        get().expireStalePermissionRequests()

        // 如果存在未完成的流式消息（如 AI 提问等待回答），先归档到 messages
        if (get().currentMessage) {
          get().finishMessage()
        }

        const currentWorkspace = deps.getWorkspace()
        const actualWorkspaceDir = workspaceDir || currentWorkspace?.path

        // 构建工作区提示词
        const { workspacePrompt, userPrompt, contextWorkspaces, allWorkspaces } =
          buildWorkspacePrompts(deps.getWorkspace, deps.getContextWorkspaceIds, deps.getAllWorkspaces)

        // 解析工作区引用
        const { processedMessage } = parseWorkspaceReferences(
          content,
          allWorkspaces,
          contextWorkspaces,
          currentWorkspace?.id || null
        )

        log.info('sendMessage debug', {
          sessionId,
          conversationId,
          providedWorkspaceDir: workspaceDir,
          actualWorkspaceDir,
          currentWorkspace: currentWorkspace ? { id: currentWorkspace.id, name: currentWorkspace.name, path: currentWorkspace.path } : null,
          workspacePromptLength: workspacePrompt.length,
          userPromptLength: userPrompt?.length ?? 0,
        })

        // 构建用户消息
        const userMessage = {
          id: generateUUID(),
          type: 'user' as const,
          content,
          timestamp: new Date().toISOString(),
          attachments: attachments?.map(a => ({
            id: a.id,
            type: a.type,
            fileName: a.fileName,
            fileSize: a.fileSize,
            mimeType: a.mimeType,
          })),
        }
        get().addMessage(userMessage)

        if (messages.length === 0) {
          const title = generateTitleFromMessage(content)
          sessionStoreManager.getState().updateSessionTitle(sessionId, title)
        }

        get().clearInputDraft()

        set({
          isStreaming: true,
          error: null,
          currentMessage: null,
          toolBlockMap: new Map(),
          mediaBlockMap: new Map(),
        })

        try {
          // Agnes 引擎：前端 generator 路径（输入即生图），不经后端 invoke / eventRouter
          if (engine === 'agnes') {
            await runAgnesImageGeneration(content, set, get, (s) => { _agnesSession = s })
            return
          }

          const router = deps.getEventRouter()
          await router.initialize()

          const attachmentsForBackend = attachments?.map(a => ({
            type: a.type,
            fileName: a.fileName,
            mimeType: a.mimeType,
            content: a.content,
            textContent: a.textContent,
          }))

          const sessionConfig = getSessionConfig()
          const runtimeConfig = resolveRuntimeConfigForEngine(sessionConfig, engine)
          // P1: 会话级 Profile 绑定（三态解析）— 会话覆盖（含「明确官方」哨兵）优先，
          // 降级状态栏镜像，再降级设置页激活的全局默认；返回 undefined 表示走官方端点。
          const sessionMeta = sessionStoreManager.getState().sessionMetadata.get(get().sessionId)
          const modelProfileId = resolveEffectiveProfileId(
            sessionMeta?.modelProfileId,
            sessionConfig.modelProfileId,
            getActiveModelProfile()?.id,
          )
          const disabledMcpServers = getDisabledPluginMcpServers()

          const chatOptions = {
            appendSystemPrompt: normalizeForInvoke(workspacePrompt),
            systemPrompt: userPrompt ? normalizeForInvoke(userPrompt) : null,
            workDir: actualWorkspaceDir,
            contextId: deps.contextId,
            engineId: engine,
            enableMcpTools: true,
            disabledMcpServers,
            attachments: attachmentsForBackend,
            additionalDirs: contextWorkspaces.map(w => w.path).filter(Boolean),
            agent: runtimeConfig.agent,
            model: runtimeConfig.model,
            effort: runtimeConfig.effort,
            permissionMode: runtimeConfig.permissionMode,
            allowedTools: sendOptions?.allowedTools && sendOptions.allowedTools.length > 0
              ? sendOptions.allowedTools
              : undefined,
            modelProfileId,
          }

          if (conversationId) {
            await invoke('continue_chat', {
              sessionId: conversationId,
              message: normalizeForInvoke(processedMessage),
              options: chatOptions,
            })
          } else {
            const sessionMeta = sessionStoreManager.getState().sessionMetadata.get(sessionId)
            const forkSessionId = sessionMeta?.forkFromId

            const newSessionId = await invoke<string>('start_chat', {
              message: normalizeForInvoke(processedMessage),
              options: {
                ...chatOptions,
                forkSessionId: forkSessionId || undefined,
              },
            })
            set({ conversationId: newSessionId })
          }
        } catch (e) {
          set({
            error: resolveChatError(e, { sessionId, workspaceDir: actualWorkspaceDir }),
            isStreaming: false,
            currentMessage: null,
            progressMessage: null,
          })
        }
      },

      interrupt: async () => {
        const { conversationId, isStreaming } = get()
        if (!conversationId || !isStreaming) return

        const config = deps.getConfig()
        const engine = resolveSessionEngine(get().sessionId, config?.defaultEngine)

        // Agnes 引擎：前端 AbortController 中止，不经后端 invoke
        if (engine === 'agnes') {
          _agnesSession?.abort()
          _agnesSession = null
          set({ isStreaming: false })
          get().finishMessage()
          log.info('Agnes session interrupted', { conversationId })
          return
        }

        log.info('Attempting to interrupt session', { conversationId, engine, isStreaming })

        try {
          await invoke('interrupt_chat', {
            sessionId: conversationId,
            engineId: engine,
          })
          log.info('Session interrupted', { conversationId })
          set({ isStreaming: false })
          get().finishMessage()
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e))
          log.error('Interrupt failed', err, { conversationId, engine })

          // 即使中断失败,也停止前端流式状态,避免 UI 卡死
          set({ isStreaming: false })
          get().finishMessage()

          // 用户可见提示:不再静默吞错,让用户感知"后端可能仍在执行"
          // 动态导入避免循环依赖
          try {
            const { useToastStore } = await import('../toastStore')
            useToastStore.getState().error(
              i18n.t('chat:error.interruptFailed'),
              i18n.t('chat:error.interruptFailedHint')
            )
          } catch (toastErr) {
            log.warn('Toast 提示失败', { error: String(toastErr) })
          }
        }
      },

      continueChat: async (prompt = '', allowedTools?: string[]) => {
        const { conversationId } = get()
        if (!conversationId) {
          set({ error: '没有活动会话', isStreaming: false })
          return
        }

        const router = deps.getEventRouter()
        await router.initialize()

        const currentWorkspace = deps.getWorkspace()
        const actualWorkspaceDir = currentWorkspace?.path
        const config = deps.getConfig()
        const currentEngine = resolveSessionEngine(get().sessionId, config?.defaultEngine)

        const { workspacePrompt, userPrompt, contextWorkspaces } =
          buildWorkspacePrompts(deps.getWorkspace, deps.getContextWorkspaceIds, deps.getAllWorkspaces)

        log.info('continueChat debug', {
          conversationId,
          actualWorkspaceDir,
          currentWorkspace: currentWorkspace ? { id: currentWorkspace.id, name: currentWorkspace.name, path: currentWorkspace.path } : null,
          workspacePromptLength: workspacePrompt.length,
          userPromptLength: userPrompt?.length ?? 0,
        })

        set({ isStreaming: true, error: null })

        const sessionConfig = getSessionConfig()
        const runtimeConfig = resolveRuntimeConfigForEngine(sessionConfig, currentEngine)
        // P1: 会话级 Profile 绑定（三态解析）— 会话覆盖（含「明确官方」哨兵）优先，
        // 降级状态栏镜像，再降级设置页激活的全局默认；返回 undefined 表示走官方端点。
        const sessionMeta = sessionStoreManager.getState().sessionMetadata.get(get().sessionId)
        const modelProfileId = resolveEffectiveProfileId(
          sessionMeta?.modelProfileId,
          sessionConfig.modelProfileId,
          getActiveModelProfile()?.id,
        )
        const disabledMcpServers = getDisabledPluginMcpServers()

        try {
          await invoke('continue_chat', {
            sessionId: conversationId,
            message: normalizeForInvoke(prompt),
            options: {
              appendSystemPrompt: normalizeForInvoke(workspacePrompt),
              systemPrompt: userPrompt ? normalizeForInvoke(userPrompt) : null,
              workDir: actualWorkspaceDir,
              contextId: deps.contextId,
              engineId: currentEngine,
              enableMcpTools: true,
              disabledMcpServers,
              additionalDirs: contextWorkspaces.map(w => w.path).filter(Boolean),
              agent: runtimeConfig.agent,
              model: runtimeConfig.model,
              effort: runtimeConfig.effort,
              permissionMode: runtimeConfig.permissionMode,
              allowedTools: allowedTools && allowedTools.length > 0 ? allowedTools : undefined,
              modelProfileId,
            },
          })
        } catch (e) {
          set({
            error: resolveChatError(e, { conversationId, workspaceDir: actualWorkspaceDir }),
            isStreaming: false,
            currentMessage: null,
            progressMessage: null,
          })
        }
      },

      regenerateResponse: async (assistantMessageId) => {
        const { messages, isStreaming } = get()

        // 防止重复操作
        if (isStreaming) {
          log.warn('regenerateResponse: 当前正在流式传输，请稍后再试')
          return
        }

        // 找到目标消息的索引
        const messageIndex = messages.findIndex(m => m.id === assistantMessageId)
        if (messageIndex === -1) {
          log.warn('regenerateResponse: 未找到目标消息', { assistantMessageId })
          return
        }

        // 找到该 assistant 消息之前的最近一条 user 消息
        let userMessageIndex = -1
        for (let i = messageIndex - 1; i >= 0; i--) {
          if (messages[i].type === 'user') {
            userMessageIndex = i
            break
          }
        }

        if (userMessageIndex === -1) {
          log.warn('regenerateResponse: 未找到对应的用户消息')
          return
        }

        const userMessage = messages[userMessageIndex]
        const userContent = userMessage.type === 'user' ? userMessage.content : ''

        // 删除从 user 消息之后的所有消息（包括要重新生成的 assistant 消息）
        const newMessages = messages.slice(0, userMessageIndex)

        // 更新状态：删除后续消息，清空当前消息
        set({
          messages: newMessages,
          currentMessage: null,
          isStreaming: false,
          error: null,
        })

        log.info('regenerateResponse: 重新生成响应', {
          userMessageId: userMessage.id,
          removedCount: messages.length - userMessageIndex
        })

        // 重新发送用户消息
        // 获取工作区信息
        const workspace = deps.getWorkspace()
        const workspaceDir = workspace?.path || undefined

        // 调用 sendMessage（会自动处理重新生成）
        const { sendMessage } = get()
        await sendMessage(userContent, workspaceDir)
      },

      editAndResend: async (userMessageId, newContent) => {
        const { messages, isStreaming } = get()

        // 防止重复操作
        if (isStreaming) {
          log.warn('editAndResend: 当前正在流式传输，请稍后再试')
          return
        }

        // 找到目标消息的索引
        const messageIndex = messages.findIndex(m => m.id === userMessageId)
        if (messageIndex === -1) {
          log.warn('editAndResend: 未找到目标消息', { userMessageId })
          return
        }

        const targetMessage = messages[messageIndex]
        if (targetMessage.type !== 'user') {
          log.warn('editAndResend: 目标消息不是用户消息')
          return
        }

        // 删除从该 user 消息之后的所有消息
        const newMessages = messages.slice(0, messageIndex)

        // 更新状态
        set({
          messages: newMessages,
          currentMessage: null,
          isStreaming: false,
          error: null,
        })

        log.info('editAndResend: 编辑并重发消息', {
          originalMessageId: userMessageId,
          removedCount: messages.length - messageIndex
        })

        // 发送新内容的消息
        const workspace = deps.getWorkspace()
        const workspaceDir = workspace?.path || undefined

        const { sendMessage } = get()
        await sendMessage(newContent, workspaceDir)
      },

      loadMoreArchivedMessages: (count = 20) => {
        const { archivedMessages, messages } = get()
        if (archivedMessages.length === 0) return
        const loadCount = Math.min(count, archivedMessages.length)
        const toLoad = archivedMessages.slice(-loadCount)
        const remaining = archivedMessages.slice(0, -loadCount)
        set({
          messages: [...toLoad, ...messages],
          archivedMessages: remaining,
        })
      },

      // ===== 消息压缩 =====
      onVisibleRangeChange: (start, end) => {
        // 参数校验：防止无效范围
        if (start < 0 || end < 0 || start > end) return

        const { messages, conversationId } = get()
        if (messages.length === 0) return

        // 更新可见范围（始终更新，保证 UI 状态正确）
        set({ visibleRange: { start, end } })

        // 防抖：当新 range 与上次压缩 range 重叠 >80% 时，跳过压缩/恢复
        // 避免压缩→Virtuoso 重算高度→新 range→振荡
        if (_lastCompactionRange) {
          const overlapStart = Math.max(start, _lastCompactionRange.start)
          const overlapEnd = Math.min(end, _lastCompactionRange.end)
          const overlapSize = Math.max(0, overlapEnd - overlapStart + 1)
          const currentSize = end - start + 1
          if (currentSize > 0 && overlapSize / currentSize > 0.8) {
            return
          }
        }
        _lastCompactionRange = { start, end }

        // 计算需要压缩和恢复的索引
        const { toCompact, toHydrate } = compactor.computeRangeActions(messages.length, start, end)

        const newMessages = [...messages]
        let changed = false

        // 恢复进入可见区域的消息
        for (const idx of toHydrate) {
          if (idx < 0 || idx >= newMessages.length) continue
          const msg = newMessages[idx]
          if (isCompacted(msg)) {
            // 一级恢复：从 compactor 快照 Map 恢复
            let hydrated = compactor.hydrateMessage(msg)
            if (hydrated === msg) {
              // 快照未命中，二级降级：从 localStorage 历史恢复
              const fromHistory = hydrateFromLocalStorage(conversationId, msg.id)
              if (fromHistory) {
                hydrated = compactor.hydrateFromExternal(msg.id, fromHistory)
              }
            }
            if (hydrated !== msg) {
              newMessages[idx] = hydrated
              changed = true
            }
          }
        }

        // 压缩离开可见区域的消息
        for (const idx of toCompact) {
          if (idx < 0 || idx >= newMessages.length) continue
          const msg = newMessages[idx]
          if (!isCompacted(msg)) {
            newMessages[idx] = compactor.compactMessage(msg)
            changed = true
          }
        }

        if (changed) {
          set({ messages: newMessages })
        }
      },

      // ===== 资源清理 =====
      dispose: () => {
        // 清理缓冲定时器
        if (_paragraphTimer) {
          clearTimeout(_paragraphTimer)
          _paragraphTimer = null
        }
        _textBuffer = ''

        // 清理压缩器快照
        compactor.clearSnapshots()

        const state = get()
        // 重置状态
        set(createInitialState(state.sessionId))
      },
    }))
  )

  return store
}
