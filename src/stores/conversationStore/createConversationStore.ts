/**
 * ConversationStore 工厂函数
 *
 * 每个会话创建独立的 Store 实例
 */

import { create, StoreApi, UseBoundStore } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { invoke } from '@tauri-apps/api/core'
import type { ConversationStore, ConversationState, StoreDeps } from './types'
import type { ChatMessage } from '../../types'
import { handleAIEvent } from './eventHandler'
import { toAppError, ErrorSource } from '../../types/errors'
import { sessionStoreManager } from './sessionStoreManager'
import { parseWorkspaceReferences, buildWorkspaceSystemPrompt, getUserSystemPrompt } from '../../services/workspaceReference'
import { MessageCompactor, isCompacted } from '../../utils/messageCompactor'
import { isEditTool, extractEditDiff } from '../../utils/diffExtractor'
import { getSessionConfig } from '../sessionConfigStore'

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
function isValidMessageStructure(msg: unknown): msg is ChatMessage {
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
function hydrateFromLocalStorage(
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
function generateTitleFromMessage(content: string): string {
  // 移除换行和多余空格
  const cleanContent = content.replace(/\n/g, ' ').trim()
  const maxTitleLength = 16
  if (cleanContent.length <= maxTitleLength) {
    return cleanContent
  }
  return cleanContent.slice(0, maxTitleLength) + '...'
}

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
    streamingUpdateCounter: 0,

    // 会话状态
    conversationId: null,
    currentConversationSeed: null,
    isStreaming: false,
    error: null,
    progressMessage: null,

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

  // ===== 流式文本缓冲区 =====
  // 段落级缓冲策略：
  // 1. 首段立即显示（快速响应）
  // 2. 后续段落等待 \n\n（段落结束）才 flush
  // 3. 超时保护：200ms 内没有段落结束也 flush
  let _textBuffer = ''
  let _paragraphTimer: ReturnType<typeof setTimeout> | null = null
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
            blocks: currentMessage.blocks,
            timestamp: new Date().toISOString(),
            isStreaming: false,
          }
          set({
            messages: [...messages, completedMessage],
            currentMessage: null,
          })
        }
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
        // 追加到闭包级 buffer（O(1)，不触发 Zustand）
        _textBuffer += content

        const state = get()

        // 首次创建消息时立即 flush（保证首 token 响应速度）
        if (!state.currentMessage) {
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
          // 首次创建消息
          if (bufferToFlush) {
            set({
              currentMessage: {
                id: crypto.randomUUID(),
                blocks: [{ type: 'text', content: bufferToFlush }],
                isStreaming: true,
              },
              streamingUpdateCounter: state.streamingUpdateCounter + 1,
            })
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
            currentMessage: { id: crypto.randomUUID(), blocks: [block], isStreaming: true },
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        } else {
          set({
            currentMessage: { ...currentMessage, blocks: [...currentMessage.blocks, block] },
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
            currentMessage: { id: crypto.randomUUID(), blocks: [block], isStreaming: true },
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
            currentMessage: { id: crypto.randomUUID(), blocks: [block], isStreaming: true },
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
            currentMessage: { id: crypto.randomUUID(), blocks: [block], isStreaming: true },
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
            currentMessage: { id: crypto.randomUUID(), blocks: [block], isStreaming: true },
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
            currentMessage: { id: crypto.randomUUID(), blocks: [block], isStreaming: true },
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
        const block = {
          type: 'permission_request' as const,
          id: requestId,
          sessionId,
          denials,
          status: 'pending' as const,
        }
        const newMap = new Map(permissionRequestBlockMap)
        if (!currentMessage) {
          newMap.set(requestId, 0)
          set({
            currentMessage: { id: crypto.randomUUID(), blocks: [block], isStreaming: true },
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

      // ===== 会话控制 =====
      setConversationId: (id) => set({ conversationId: id }),
      setStreaming: (streaming) => set({ isStreaming: streaming }),
      setError: (error) => set({ error }),
      setProgressMessage: (message) => set({ progressMessage: message }),

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

      sendMessage: async (content, workspaceDir?, attachments?) => {
        const { conversationId, sessionId, messages } = get()
        const config = deps.getConfig()
        const engine = config?.defaultEngine || 'claude-code'

        // 如果存在未完成的流式消息（如 AI 提问等待回答），先归档到 messages
        // 防止 currentMessage 被清空后丢失 AI 已生成的内容
        if (get().currentMessage) {
          get().finishMessage()
        }

        // 获取工作区信息
        const currentWorkspace = deps.getWorkspace()
        const actualWorkspaceDir = workspaceDir || currentWorkspace?.path

        // 获取关联工作区
        const contextWorkspaceIds = deps.getContextWorkspaceIds()
        const allWorkspaces = deps.getAllWorkspaces()
        const contextWorkspaces = allWorkspaces.filter(w => contextWorkspaceIds.includes(w.id))

        // 解析工作区引用
        const { processedMessage } = parseWorkspaceReferences(
          content,
          allWorkspaces,
          contextWorkspaces,
          currentWorkspace?.id || null
        )

        // 构建工作区系统提示词（始终传递，通过 --append-system-prompt）
        let workspacePrompt = ''
        if (currentWorkspace) {
          workspacePrompt = buildWorkspaceSystemPrompt(currentWorkspace, contextWorkspaces)
        }

        // 构建用户自定义系统提示词（开启时传递，通过 --system-prompt）
        let userPrompt: string | null = null
        if (currentWorkspace) {
          userPrompt = getUserSystemPrompt(currentWorkspace, contextWorkspaces)
        }

        // 调试日志：打印工作区信息
        console.log('[ConversationStore] sendMessage 调试信息:', {
          sessionId,
          conversationId,
          providedWorkspaceDir: workspaceDir,
          actualWorkspaceDir,
          currentWorkspace: currentWorkspace ? { id: currentWorkspace.id, name: currentWorkspace.name, path: currentWorkspace.path } : null,
          contextWorkspaceIds,
          workspacePromptLength: workspacePrompt.length,
          userPromptLength: userPrompt?.length ?? 0,
        })

        // 构建用户消息
        const userMessage = {
          id: crypto.randomUUID(),
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

        // 如果是第一条消息，更新会话标题
        if (messages.length === 0) {
          const title = generateTitleFromMessage(content)
          sessionStoreManager.getState().updateSessionTitle(sessionId, title)
        }

        // 清空输入草稿
        get().clearInputDraft()

        // 设置流式状态
        set({
          isStreaming: true,
          error: null,
          currentMessage: null,
          toolBlockMap: new Map(),
        })

        try {
          // 初始化事件路由器
          const router = deps.getEventRouter()
          await router.initialize()

          // 准备附件数据
          const attachmentsForBackend = attachments?.map(a => ({
            type: a.type,
            fileName: a.fileName,
            mimeType: a.mimeType,
            content: a.content,
            textContent: a.textContent,
          }))

          // 规范化工作区提示词（换行符处理）
          const normalizedWorkspacePrompt = workspacePrompt
            .replace(/\r\n/g, '\\n')
            .replace(/\r/g, '\\n')
            .replace(/\n/g, '\\n')
            .trim()

          // 规范化用户提示词（换行符处理）
          const normalizedUserPrompt = userPrompt
            ? userPrompt
                .replace(/\r\n/g, '\\n')
                .replace(/\r/g, '\\n')
                .replace(/\n/g, '\\n')
                .trim()
            : null

          // 规范化消息（换行符处理）
          const normalizedMessage = processedMessage
            .replace(/\r\n/g, '\\n')
            .replace(/\r/g, '\\n')
            .replace(/\n/g, '\\n')
            .trim()

          // 调用后端 API
          // 获取会话配置
          const sessionConfig = getSessionConfig()

          if (conversationId) {
            // 继续会话
            await invoke('continue_chat', {
              sessionId: conversationId,
              message: normalizedMessage,
              options: {
                appendSystemPrompt: normalizedWorkspacePrompt,
                systemPrompt: normalizedUserPrompt,
                workDir: actualWorkspaceDir,
                contextId: deps.contextId,
                engineId: engine,
                enableMcpTools: engine === 'claude-code',
                attachments: attachmentsForBackend,
                additionalDirs: contextWorkspaces.map(w => w.path).filter(Boolean),
                agent: sessionConfig.agent || undefined,
                model: sessionConfig.model || undefined,
                effort: sessionConfig.effort || undefined,
                permissionMode: sessionConfig.permissionMode || undefined,
              },
            })
          } else {
            // 新会话
            // 检查是否有 forkFromId（Fork 分支会话）
            const sessionMeta = sessionStoreManager.getState().sessionMetadata.get(sessionId)
            const forkSessionId = sessionMeta?.forkFromId

            const newSessionId = await invoke<string>('start_chat', {
              message: normalizedMessage,
              options: {
                appendSystemPrompt: normalizedWorkspacePrompt,
                systemPrompt: normalizedUserPrompt,
                workDir: actualWorkspaceDir,
                contextId: deps.contextId,
                engineId: engine,
                enableMcpTools: engine === 'claude-code',
                attachments: attachmentsForBackend,
                additionalDirs: contextWorkspaces.map(w => w.path).filter(Boolean),
                agent: sessionConfig.agent || undefined,
                model: sessionConfig.model || undefined,
                effort: sessionConfig.effort || undefined,
                permissionMode: sessionConfig.permissionMode || undefined,
                forkSessionId: forkSessionId || undefined,
              },
            })
            // 注意：这里设置的是临时 sessionId，真实的会话 ID 通过 session_start 事件设置
            set({ conversationId: newSessionId })
          }
        } catch (e) {
          const appError = toAppError(e, {
            source: ErrorSource.AI,
            context: { sessionId, workspaceDir: actualWorkspaceDir }
          })

          set({
            error: appError.getUserMessage(),
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
        const engine = config?.defaultEngine || 'claude-code'

        console.log('[ConversationStore] 尝试中断会话:', { conversationId, engine, isStreaming })

        try {
          await invoke('interrupt_chat', {
            sessionId: conversationId,
            engineId: engine,
          })
          console.log('[ConversationStore] 中断成功:', conversationId)
          set({ isStreaming: false })
          get().finishMessage()
        } catch (e) {
          console.error('[ConversationStore] interrupt failed:', e)
          // 即使中断失败，也停止流式状态
          set({ isStreaming: false })
          get().finishMessage()
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

        // 获取工作区信息
        const currentWorkspace = deps.getWorkspace()
        const actualWorkspaceDir = currentWorkspace?.path
        const config = deps.getConfig()
        const currentEngine = config?.defaultEngine || 'claude-code'

        // 获取关联工作区
        const contextWorkspaceIds = deps.getContextWorkspaceIds()
        const allWorkspaces = deps.getAllWorkspaces()
        const contextWorkspaces = allWorkspaces.filter(w => contextWorkspaceIds.includes(w.id))

        // 构建工作区系统提示词（始终传递，通过 --append-system-prompt）
        let workspacePrompt = ''
        if (currentWorkspace) {
          workspacePrompt = buildWorkspaceSystemPrompt(currentWorkspace, contextWorkspaces)
        }

        // 构建用户自定义系统提示词（开启时传递，通过 --system-prompt）
        let userPrompt: string | null = null
        if (currentWorkspace) {
          userPrompt = getUserSystemPrompt(currentWorkspace, contextWorkspaces)
        }

        // 调试日志：打印工作区信息
        console.log('[ConversationStore] continueChat 调试信息:', {
          conversationId,
          actualWorkspaceDir,
          currentWorkspace: currentWorkspace ? { id: currentWorkspace.id, name: currentWorkspace.name, path: currentWorkspace.path } : null,
          contextWorkspaceIds,
          workspacePromptLength: workspacePrompt.length,
          userPromptLength: userPrompt?.length ?? 0,
        })

        const normalizedPrompt = prompt
          .replace(/\r\n/g, '\\n')
          .replace(/\r/g, '\\n')
          .replace(/\n/g, '\\n')
          .trim()

        // 规范化工作区提示词
        const normalizedWorkspacePrompt = workspacePrompt
          .replace(/\r\n/g, '\\n')
          .replace(/\r/g, '\\n')
          .replace(/\n/g, '\\n')
          .trim()

        // 规范化用户提示词
        const normalizedUserPrompt = userPrompt
          ? userPrompt
              .replace(/\r\n/g, '\\n')
              .replace(/\r/g, '\\n')
              .replace(/\n/g, '\\n')
              .trim()
          : null

        set({ isStreaming: true, error: null })

        // 获取会话配置
        const sessionConfig = getSessionConfig()

        try {
          await invoke('continue_chat', {
            sessionId: conversationId,
            message: normalizedPrompt,
            options: {
              appendSystemPrompt: normalizedWorkspacePrompt,
              systemPrompt: normalizedUserPrompt,
              workDir: actualWorkspaceDir,
              contextId: deps.contextId,
              engineId: currentEngine,
              additionalDirs: contextWorkspaces.map(w => w.path).filter(Boolean),
              agent: sessionConfig.agent || undefined,
              model: sessionConfig.model || undefined,
              effort: sessionConfig.effort || undefined,
              permissionMode: sessionConfig.permissionMode || undefined,
              allowedTools: allowedTools && allowedTools.length > 0 ? allowedTools : undefined,
            },
          })
        } catch (e) {
          const appError = toAppError(e, {
            source: ErrorSource.AI,
            context: { conversationId, workspaceDir: actualWorkspaceDir }
          })

          set({
            error: appError.getUserMessage(),
            isStreaming: false,
            currentMessage: null,
            progressMessage: null,
          })
        }
      },

      regenerateResponse: async (_assistantMessageId) => {
        // TODO: 实现重新生成
        console.log('[ConversationStore] regenerateResponse not implemented yet')
      },

      editAndResend: async (_userMessageId, _newContent) => {
        // TODO: 实现编辑重发
        console.log('[ConversationStore] editAndResend not implemented yet')
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