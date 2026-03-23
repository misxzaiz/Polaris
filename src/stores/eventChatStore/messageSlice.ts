/**
 * 消息状态 Slice
 *
 * 负责消息的 CRUD 操作和流式消息构建
 *
 * 持久化说明：
 * - 会话元数据由 zustand persist 中间件自动持久化
 * - 消息数据需要通过 saveToHistory() 手动保存
 */

import type { MessageSlice, CurrentAssistantMessage } from './types'
import type { ContentBlock, ToolCallBlock, QuestionBlock, PlanModeBlock } from '../../types'
import { MESSAGE_ARCHIVE_THRESHOLD } from './types'
import { isTextBlock } from '../../types'
import { generateToolSummary, calculateDuration } from '../../utils/toolSummary'
import { clearFileReadCache } from './utils'

/**
 * 创建消息状态 Slice
 */
export const createMessageSlice: MessageSlice = (set, get) => ({
  // ===== 状态 =====
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
  streamingUpdateCounter: 0,

  // ===== 方法 =====

  addMessage: (message) => {
    set((state) => {
      const newMessages = [...state.messages, message]

      if (newMessages.length > MESSAGE_ARCHIVE_THRESHOLD) {
        const archiveCount = newMessages.length - state.maxMessages
        const toArchive = newMessages.slice(0, archiveCount)
        const remaining = newMessages.slice(archiveCount)

        // 注意：不再手动保存到 sessionStorage，由 zustand persist 自动管理
        // 但消息数据不会自动持久化，用户需要手动调用 saveToHistory() 保存

        return {
          messages: remaining,
          archivedMessages: toArchive,
        }
      }

      return { messages: newMessages }
    })

    // 注意：不再调用 saveToStorage()，由 zustand persist 自动管理
    // conversationId 会自动持久化，消息数据需手动保存到历史
  },

  clearMessages: () => {
    // 清理 Provider Session
    const { providerSessionCache } = get()
    if (providerSessionCache?.session) {
      try {
        providerSessionCache.session.dispose()
      } catch (e) {
        console.warn('[EventChatStore] 清理 Session 失败:', e)
      }
    }

    // 注意：不清理事件监听器
    // 事件监听器应该在应用生命周期内保持活跃，而不是与单个对话绑定
    // 它们由 App.tsx 的 useEffect 管理，只在组件卸载时清理

    // 清理文件读取缓存
    clearFileReadCache()

    // 使用注入的依赖清理工具面板
    const toolPanelActions = get().getToolPanelActions()
    if (toolPanelActions) {
      toolPanelActions.clearTools()
    }

    set({
      messages: [],
      archivedMessages: [],
      isArchiveExpanded: false,
      conversationId: null,
      currentConversationSeed: null,
      progressMessage: null,
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
      providerSessionCache: null,
      // 不重置事件监听器状态，保持其在应用生命周期内活跃
    })
  },

  /**
   * 完成当前消息
   * 将 currentMessage 标记为完成，并清空
   */
  finishMessage: () => {
    const { currentMessage, messages } = get()

    if (currentMessage) {
      // 标记消息为完成状态
      const completedMessage = {
        id: currentMessage.id,
        type: 'assistant' as const,
        blocks: currentMessage.blocks,
        timestamp: new Date().toISOString(),
        isStreaming: false,
      }

      // 更新消息列表中的当前消息（如果已存在）
      const messageIndex = messages.findIndex(m => m.id === currentMessage.id)
      if (messageIndex >= 0) {
        set((state) => ({
          messages: state.messages.map((m, i) =>
            i === messageIndex ? completedMessage : m
          ),
          currentMessage: null,
          progressMessage: null,
          isStreaming: false,
        }))
      } else {
        // 如果消息不在列表中（理论上不应该发生），添加它
        set((state) => ({
          messages: [...state.messages, completedMessage],
          currentMessage: null,
          progressMessage: null,
          isStreaming: false,
        }))
      }
    } else {
      // 即使没有 currentMessage，也要重置状态
      set({ isStreaming: false })
    }

    // 注意：不再调用 saveToStorage()，由 zustand persist 自动管理
  },

  /**
   * 添加文本块到当前消息（直接追加）
   */
  appendTextBlock: (content) => {
    const { currentMessage } = get()

    // 如果没有当前消息，创建一个新的
    if (!currentMessage) {
      const newMessage: CurrentAssistantMessage = {
        id: crypto.randomUUID(),
        blocks: [{ type: 'text', content }],
        isStreaming: true,
      }
      set({
        currentMessage: newMessage,
        isStreaming: true,
      })
      return
    }

    // 追加到最后一个文本块
    const lastBlock = currentMessage.blocks[currentMessage.blocks.length - 1]
    if (lastBlock && isTextBlock(lastBlock)) {
      const updatedBlocks: ContentBlock[] = [...currentMessage.blocks]
      updatedBlocks[updatedBlocks.length - 1] = {
        type: 'text',
        content: lastBlock.content + content,
      }
      set((state) => ({
        currentMessage: state.currentMessage
          ? { ...state.currentMessage, blocks: updatedBlocks }
          : null,
        streamingUpdateCounter: (state.streamingUpdateCounter || 0) + 1,
      }))
    } else {
      // 最后一个块不是文本，创建新的文本块
      const textBlock: ContentBlock = { type: 'text', content }
      const updatedBlocks: ContentBlock[] = [...currentMessage.blocks, textBlock]
      set((state) => ({
        currentMessage: state.currentMessage
          ? { ...state.currentMessage, blocks: updatedBlocks }
          : null,
        streamingUpdateCounter: (state.streamingUpdateCounter || 0) + 1,
      }))
    }
  },

  /**
   * 添加思考过程块到当前消息
   */
  appendThinkingBlock: (content) => {
    const { currentMessage } = get()

    const thinkingBlock: ContentBlock = {
      type: 'thinking',
      content,
      collapsed: false,
    }

    // 如果没有当前消息，创建一个新的
    if (!currentMessage) {
      const newMessage: CurrentAssistantMessage = {
        id: crypto.randomUUID(),
        blocks: [thinkingBlock],
        isStreaming: true,
      }
      set({
        currentMessage: newMessage,
        isStreaming: true,
      })
      return
    }

    // 追加思考块到现有消息
    const updatedBlocks: ContentBlock[] = [...currentMessage.blocks, thinkingBlock]
    set({
      currentMessage: { ...currentMessage, blocks: updatedBlocks },
    })
  },

  /**
   * 添加工具调用块到当前消息
   */
  appendToolCallBlock: (toolId, toolName, input) => {
    const { currentMessage } = get()
    const toolPanelActions = get().getToolPanelActions()
    const now = new Date().toISOString()

    const toolBlock: ToolCallBlock = {
      type: 'tool_call',
      id: toolId,
      name: toolName,
      input,
      status: 'pending',
      startedAt: now,
    }

    // 如果没有当前消息，创建一个新的（可能工具调用在文本之前到达）
    if (!currentMessage) {
      console.log('[EventChatStore] 创建新消息（工具调用优先）')
      const newMessage: CurrentAssistantMessage = {
        id: crypto.randomUUID(),
        blocks: [toolBlock],
        isStreaming: true,
      }
      set({
        currentMessage: newMessage,
        isStreaming: true,
        toolBlockMap: new Map([[toolId, 0]]),
      })

      // 同步到工具面板
      if (toolPanelActions) {
        toolPanelActions.addTool({
          id: toolId,
          name: toolName,
          status: 'pending',
          input,
          startedAt: now,
        })
      }

      // 更新进度消息
      const summary = generateToolSummary(toolName, input, 'pending')
      set({ progressMessage: summary })
      return
    }

    // 添加工具块
    const updatedBlocks: ContentBlock[] = [...currentMessage.blocks, toolBlock]
    const blockIndex = updatedBlocks.length - 1

    // 直接修改 toolBlockMap 而非创建新 Map
    const existingMap = get().toolBlockMap
    existingMap.set(toolId, blockIndex)

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
      toolBlockMap: existingMap,
    }))

    // 更新消息列表中的消息
    get().updateCurrentAssistantMessage(updatedBlocks)

    // 同步到工具面板
    if (toolPanelActions) {
      toolPanelActions.addTool({
        id: toolId,
        name: toolName,
        status: 'pending',
        input,
        startedAt: now,
      })
    }

    // 更新进度消息
    set({ progressMessage: generateToolSummary(toolName, input, 'pending') })
  },

  /**
   * 更新工具调用块状态
   */
  updateToolCallBlock: (toolId, status, output, error) => {
    const { currentMessage, toolBlockMap } = get()
    const toolPanelActions = get().getToolPanelActions()
    const blockIndex = toolBlockMap.get(toolId)

    if (!currentMessage || blockIndex === undefined) {
      console.warn('[EventChatStore] Tool block not found:', toolId)
      return
    }

    const block = currentMessage.blocks[blockIndex]
    if (!block || block.type !== 'tool_call') {
      console.warn('[EventChatStore] Invalid tool block at index:', blockIndex)
      return
    }

    const now = new Date().toISOString()
    const duration = calculateDuration(block.startedAt, now)

    // 更新工具块
    const updatedBlock: ToolCallBlock = {
      ...block,
      status,
      output,
      error,
      completedAt: now,
      duration,
    }

    const updatedBlocks = [...currentMessage.blocks]
    updatedBlocks[blockIndex] = updatedBlock

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
    }))

    // 更新消息列表中的消息
    get().updateCurrentAssistantMessage(updatedBlocks)

    // 同步到工具面板
    if (toolPanelActions) {
      toolPanelActions.updateTool(toolId, {
        status,
        output: output ? String(output) : undefined,
        completedAt: now,
      })
    }

    // 更新进度消息
    set({ progressMessage: generateToolSummary(block.name, block.input, status) })
  },

  /**
   * 更新工具调用块的 Diff 数据
   */
  updateToolCallBlockDiff: (toolId, diffData) => {
    const { currentMessage, toolBlockMap } = get()
    const blockIndex = toolBlockMap.get(toolId)

    if (!currentMessage || blockIndex === undefined) {
      console.warn('[EventChatStore] Tool block not found for diff update:', toolId)
      return
    }

    const block = currentMessage.blocks[blockIndex]
    if (!block || block.type !== 'tool_call') {
      console.warn('[EventChatStore] Invalid tool block at index:', blockIndex)
      return
    }

    // 合并更新：保留已有的 fullOldContent
    const updatedBlock: ToolCallBlock = {
      ...block,
      diffData: {
        ...block.diffData,
        ...diffData,
      } as ToolCallBlock['diffData'],
    }

    const updatedBlocks = [...currentMessage.blocks]
    updatedBlocks[blockIndex] = updatedBlock

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
    }))

    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 更新工具调用块的完整文件内容（用于撤销）
   */
  updateToolCallBlockFullContent: (toolId, fullContent) => {
    const { currentMessage, toolBlockMap } = get()
    const blockIndex = toolBlockMap.get(toolId)

    if (!currentMessage || blockIndex === undefined) {
      console.warn('[EventChatStore] Tool block not found for full content update:', toolId)
      return
    }

    const block = currentMessage.blocks[blockIndex]
    if (!block || block.type !== 'tool_call') {
      console.warn('[EventChatStore] Invalid tool block at index:', blockIndex)
      return
    }

    // 更新 diffData 中的 fullOldContent
    const updatedBlock: ToolCallBlock = {
      ...block,
      diffData: {
        ...block.diffData,
        fullOldContent: fullContent,
      } as ToolCallBlock['diffData'],
    }

    const updatedBlocks = [...currentMessage.blocks]
    updatedBlocks[blockIndex] = updatedBlock

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
    }))

    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 更新当前 Assistant 消息（内部方法）
   */
  updateCurrentAssistantMessage: (blocks) => {
    const { currentMessage } = get()
    if (!currentMessage) return

    set((state) => ({
      messages: state.messages.map(msg =>
        msg.id === currentMessage!.id
          ? { ...msg, blocks }
          : msg
      ),
    }))
  },

  /**
   * 添加问题块（AskUserQuestion 工具）
   */
  appendQuestionBlock: (questionId, header, options, multiSelect, allowCustomInput, categoryLabel) => {
    const { currentMessage } = get()

    const questionBlock: QuestionBlock = {
      type: 'question',
      id: questionId,
      header,
      categoryLabel,
      options,
      multiSelect,
      allowCustomInput,
      status: 'pending',
    }

    // 如果没有当前消息，创建一个新的
    if (!currentMessage) {
      const newMessage: CurrentAssistantMessage = {
        id: crypto.randomUUID(),
        blocks: [questionBlock],
        isStreaming: true,
      }
      set({
        currentMessage: newMessage,
        isStreaming: true,
        questionBlockMap: new Map([[questionId, 0]]),
      })
      return
    }

    // 添加问题块
    const updatedBlocks: ContentBlock[] = [...currentMessage.blocks, questionBlock]
    const blockIndex = updatedBlocks.length - 1

    // 直接修改 questionBlockMap
    const existingMap = get().questionBlockMap
    existingMap.set(questionId, blockIndex)

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
      questionBlockMap: existingMap,
    }))

    // 更新消息列表中的消息
    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 更新问题块答案
   */
  updateQuestionBlock: (questionId, answer) => {
    const { currentMessage, questionBlockMap } = get()
    const blockIndex = questionBlockMap.get(questionId)

    if (!currentMessage || blockIndex === undefined) {
      console.warn('[EventChatStore] Question block not found:', questionId)
      return
    }

    const block = currentMessage.blocks[blockIndex]
    if (!block || block.type !== 'question') {
      console.warn('[EventChatStore] Invalid question block at index:', blockIndex)
      return
    }

    // 更新问题块
    const updatedBlock: QuestionBlock = {
      ...block,
      status: 'answered',
      answer,
    }

    const updatedBlocks = [...currentMessage.blocks]
    updatedBlocks[blockIndex] = updatedBlock

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
    }))

    // 更新消息列表中的消息
    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 添加计划模式块
   */
  appendPlanModeBlock: (planId, sessionId, title, description, stages) => {
    const { currentMessage } = get()

    const planBlock: PlanModeBlock = {
      type: 'plan_mode',
      id: planId,
      sessionId,
      title,
      description,
      stages: stages || [],
      status: 'drafting',
      isActive: true,
    }

    // 如果没有当前消息，创建一个新的
    if (!currentMessage) {
      const newMessage: CurrentAssistantMessage = {
        id: crypto.randomUUID(),
        blocks: [planBlock],
        isStreaming: true,
      }
      set({
        currentMessage: newMessage,
        isStreaming: true,
        planBlockMap: new Map([[planId, 0]]),
        activePlanId: planId,
      })
      return
    }

    // 添加计划块
    const updatedBlocks: ContentBlock[] = [...currentMessage.blocks, planBlock]
    const blockIndex = updatedBlocks.length - 1

    // 更新 planBlockMap
    const existingMap = get().planBlockMap
    existingMap.set(planId, blockIndex)

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
      planBlockMap: existingMap,
      activePlanId: planId,
    }))

    // 更新消息列表中的消息
    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 更新计划模式块
   */
  updatePlanModeBlock: (planId, updates) => {
    const { currentMessage, planBlockMap } = get()
    const blockIndex = planBlockMap.get(planId)

    if (!currentMessage || blockIndex === undefined) {
      console.warn('[EventChatStore] Plan block not found:', planId)
      return
    }

    const block = currentMessage.blocks[blockIndex]
    if (!block || block.type !== 'plan_mode') {
      console.warn('[EventChatStore] Invalid plan block at index:', blockIndex)
      return
    }

    // 更新计划块
    const updatedBlock: PlanModeBlock = {
      ...block,
      ...updates,
    }

    const updatedBlocks = [...currentMessage.blocks]
    updatedBlocks[blockIndex] = updatedBlock

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
    }))

    // 更新消息列表中的消息
    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 更新计划阶段状态
   */
  updatePlanStageStatus: (planId, stageId, status, tasks) => {
    const { currentMessage, planBlockMap } = get()
    const blockIndex = planBlockMap.get(planId)

    if (!currentMessage || blockIndex === undefined) {
      console.warn('[EventChatStore] Plan block not found:', planId)
      return
    }

    const block = currentMessage.blocks[blockIndex]
    if (!block || block.type !== 'plan_mode') {
      console.warn('[EventChatStore] Invalid plan block at index:', blockIndex)
      return
    }

    // 更新阶段状态
    const updatedStages = block.stages.map((stage) => {
      if (stage.stageId === stageId) {
        return {
          ...stage,
          status,
          tasks: tasks !== undefined ? tasks : stage.tasks,
        }
      }
      return stage
    })

    const updatedBlock: PlanModeBlock = {
      ...block,
      stages: updatedStages,
    }

    const updatedBlocks = [...currentMessage.blocks]
    updatedBlocks[blockIndex] = updatedBlock

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
    }))

    // 更新消息列表中的消息
    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 设置活跃计划
   */
  setActivePlan: (planId) => {
    set({ activePlanId: planId })
  },

  // ========================================
  // AgentRun 方法
  // ========================================

  /**
   * 添加 Agent 运行块
   */
  appendAgentRunBlock: (taskId, agentType, capabilities) => {
    const { currentMessage } = get()

    const agentBlock: import('../../types/chat').AgentRunBlock = {
      type: 'agent_run',
      id: taskId,
      agentType,
      capabilities,
      status: 'running',
      toolCalls: [],
      startedAt: new Date().toISOString(),
    }

    // 如果没有当前消息，创建一个新的
    if (!currentMessage) {
      const newMessage: CurrentAssistantMessage = {
        id: crypto.randomUUID(),
        blocks: [agentBlock],
        isStreaming: true,
      }
      set({
        currentMessage: newMessage,
        isStreaming: true,
        agentRunBlockMap: new Map([[taskId, 0]]),
        activeTaskId: taskId,
      })
      return
    }

    // 添加 Agent 块
    const updatedBlocks: ContentBlock[] = [...currentMessage.blocks, agentBlock]
    const blockIndex = updatedBlocks.length - 1

    // 更新 agentRunBlockMap
    const existingMap = get().agentRunBlockMap
    existingMap.set(taskId, blockIndex)

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
      agentRunBlockMap: existingMap,
      activeTaskId: taskId,
    }))

    // 更新消息列表中的消息
    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 更新 Agent 运行块
   */
  updateAgentRunBlock: (taskId, updates) => {
    const { currentMessage, agentRunBlockMap } = get()
    const blockIndex = agentRunBlockMap.get(taskId)

    if (!currentMessage || blockIndex === undefined) {
      console.warn('[EventChatStore] AgentRun block not found:', taskId)
      return
    }

    const block = currentMessage.blocks[blockIndex]
    if (!block || block.type !== 'agent_run') {
      console.warn('[EventChatStore] Invalid agent_run block at index:', blockIndex)
      return
    }

    // 更新 Agent 块
    const updatedBlock: import('../../types/chat').AgentRunBlock = {
      ...block,
      ...updates,
    }

    const updatedBlocks = [...currentMessage.blocks]
    updatedBlocks[blockIndex] = updatedBlock

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
    }))

    // 更新消息列表中的消息
    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 添加嵌套工具调用到 AgentRun
   */
  appendAgentToolCall: (taskId, toolId, toolName) => {
    const { currentMessage, agentRunBlockMap } = get()
    const blockIndex = agentRunBlockMap.get(taskId)

    if (!currentMessage || blockIndex === undefined) {
      console.warn('[EventChatStore] AgentRun block not found for tool call:', taskId)
      return
    }

    const block = currentMessage.blocks[blockIndex]
    if (!block || block.type !== 'agent_run') {
      console.warn('[EventChatStore] Invalid agent_run block at index:', blockIndex)
      return
    }

    // 添加新的嵌套工具调用
    const newToolCall: import('../../types/chat').AgentNestedToolCall = {
      id: toolId,
      name: toolName,
      status: 'pending',
    }

    const updatedBlock: import('../../types/chat').AgentRunBlock = {
      ...block,
      toolCalls: [...block.toolCalls, newToolCall],
    }

    const updatedBlocks = [...currentMessage.blocks]
    updatedBlocks[blockIndex] = updatedBlock

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
    }))

    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 更新嵌套工具调用状态
   */
  updateAgentToolCallStatus: (taskId, toolId, status, summary) => {
    const { currentMessage, agentRunBlockMap } = get()
    const blockIndex = agentRunBlockMap.get(taskId)

    if (!currentMessage || blockIndex === undefined) {
      console.warn('[EventChatStore] AgentRun block not found:', taskId)
      return
    }

    const block = currentMessage.blocks[blockIndex]
    if (!block || block.type !== 'agent_run') {
      console.warn('[EventChatStore] Invalid agent_run block at index:', blockIndex)
      return
    }

    // 更新嵌套工具调用状态
    const updatedToolCalls = block.toolCalls.map((tc) => {
      if (tc.id === toolId) {
        return { ...tc, status, summary }
      }
      return tc
    })

    const updatedBlock: import('../../types/chat').AgentRunBlock = {
      ...block,
      toolCalls: updatedToolCalls,
    }

    const updatedBlocks = [...currentMessage.blocks]
    updatedBlocks[blockIndex] = updatedBlock

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
    }))

    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 设置活跃任务
   */
  setActiveTask: (taskId) => {
    set({ activeTaskId: taskId })
  },

  // ========================================
  // ToolGroup 方法
  // ========================================

  /**
   * 添加工具组块
   */
  appendToolGroupBlock: (groupId, tools, summary) => {
    const { currentMessage } = get()

    const toolGroupBlock: import('../../types/chat').ToolGroupBlock = {
      type: 'tool_group',
      id: groupId,
      tools: tools.map(t => ({
        id: t.id,
        name: t.name,
        status: t.status,
        startedAt: t.startedAt,
      })),
      toolNames: [...new Set(tools.map(t => t.name))],
      status: 'running',
      summary,
      startedAt: tools[0]?.startedAt || new Date().toISOString(),
    }

    // 如果没有当前消息，创建一个新的
    if (!currentMessage) {
      const newMessage: CurrentAssistantMessage = {
        id: crypto.randomUUID(),
        blocks: [toolGroupBlock],
        isStreaming: true,
      }
      set({
        currentMessage: newMessage,
        isStreaming: true,
        toolGroupBlockMap: new Map([[groupId, 0]]),
      })
      return
    }

    // 添加工具组块
    const updatedBlocks: ContentBlock[] = [...currentMessage.blocks, toolGroupBlock]
    const blockIndex = updatedBlocks.length - 1

    // 更新 toolGroupBlockMap
    const existingMap = get().toolGroupBlockMap
    existingMap.set(groupId, blockIndex)

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
      toolGroupBlockMap: existingMap,
    }))

    // 更新消息列表中的消息
    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 更新工具组块
   */
  updateToolGroupBlock: (groupId, updates) => {
    const { currentMessage, toolGroupBlockMap } = get()
    const blockIndex = toolGroupBlockMap.get(groupId)

    if (!currentMessage || blockIndex === undefined) {
      console.warn('[EventChatStore] ToolGroup block not found:', groupId)
      return
    }

    const block = currentMessage.blocks[blockIndex]
    if (!block || block.type !== 'tool_group') {
      console.warn('[EventChatStore] Invalid tool_group block at index:', blockIndex)
      return
    }

    // 更新工具组块
    const updatedBlock: import('../../types/chat').ToolGroupBlock = {
      ...block,
      ...updates,
    }

    const updatedBlocks = [...currentMessage.blocks]
    updatedBlocks[blockIndex] = updatedBlock

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
    }))

    // 更新消息列表中的消息
    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 更新工具组内的工具状态
   */
  updateToolInGroup: (groupId, toolId, updates) => {
    const { currentMessage, toolGroupBlockMap } = get()
    const blockIndex = toolGroupBlockMap.get(groupId)

    if (!currentMessage || blockIndex === undefined) {
      console.warn('[EventChatStore] ToolGroup block not found:', groupId)
      return
    }

    const block = currentMessage.blocks[blockIndex]
    if (!block || block.type !== 'tool_group') {
      console.warn('[EventChatStore] Invalid tool_group block at index:', blockIndex)
      return
    }

    // 更新工具组内的工具状态
    const updatedTools = block.tools.map((t) => {
      if (t.id === toolId) {
        return { ...t, ...updates }
      }
      return t
    })

    // 计算整体状态
    const allCompleted = updatedTools.every(t => t.status === 'completed')
    const anyFailed = updatedTools.some(t => t.status === 'failed')
    const anyRunning = updatedTools.some(t => t.status === 'running' || t.status === 'pending')

    let groupStatus: import('../../types/chat').ToolGroupStatus = 'running'
    if (allCompleted) {
      groupStatus = 'completed'
    } else if (anyFailed && !anyRunning) {
      groupStatus = 'failed'
    } else if (anyFailed) {
      groupStatus = 'partial'
    }

    const now = new Date().toISOString()
    const duration = block.startedAt ? calculateDuration(block.startedAt, now) : undefined

    const updatedBlock: import('../../types/chat').ToolGroupBlock = {
      ...block,
      tools: updatedTools,
      status: groupStatus,
      completedAt: allCompleted || (!anyRunning && anyFailed) ? now : undefined,
      duration,
    }

    const updatedBlocks = [...currentMessage.blocks]
    updatedBlocks[blockIndex] = updatedBlock

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
    }))

    // 更新消息列表中的消息
    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 设置待聚合的工具组
   */
  setPendingToolGroup: (group) => {
    // 清理旧的计时器
    const { pendingToolGroup } = get()
    if (pendingToolGroup?.timerId) {
      clearTimeout(pendingToolGroup.timerId)
    }
    set({ pendingToolGroup: group })
  },

  /**
   * 添加工具到待聚合组
   */
  addToolToPendingGroup: (tool) => {
    const { pendingToolGroup } = get()

    if (!pendingToolGroup) {
      // 创建新的待聚合组
      const newGroup: import('./types').PendingToolGroup = {
        groupId: crypto.randomUUID(),
        tools: [{
          id: tool.id,
          name: tool.name,
          input: tool.input,
          status: 'running',
          startedAt: tool.startedAt,
        }],
        startedAt: tool.startedAt,
        lastToolAt: Date.now(),
      }
      set({ pendingToolGroup: newGroup })
      return
    }

    // 添加到现有组
    const updatedGroup: import('./types').PendingToolGroup = {
      ...pendingToolGroup,
      tools: [...pendingToolGroup.tools, {
        id: tool.id,
        name: tool.name,
        input: tool.input,
        status: 'running',
        startedAt: tool.startedAt,
      }],
      lastToolAt: Date.now(),
    }
    set({ pendingToolGroup: updatedGroup })
  },

  /**
   * 完成待聚合组并创建 ToolGroupBlock
   */
  finalizePendingToolGroup: () => {
    const { pendingToolGroup } = get()

    if (!pendingToolGroup || pendingToolGroup.tools.length < 2) {
      // 工具数量不足，不创建工具组
      set({ pendingToolGroup: null })
      return
    }

    // 生成摘要
    const toolNames = [...new Set(pendingToolGroup.tools.map(t => t.name))]
    const summary = toolNames.length === 1
      ? `${toolNames[0]} ×${pendingToolGroup.tools.length}`
      : `${pendingToolGroup.tools.length} 个工具`

    // 创建 ToolGroupBlock
    get().appendToolGroupBlock(
      pendingToolGroup.groupId,
      pendingToolGroup.tools.map(t => ({
        id: t.id,
        name: t.name,
        status: t.status,
        startedAt: t.startedAt,
      })),
      summary
    )

    // 清除待聚合组
    set({ pendingToolGroup: null })
  },

  /**
   * 添加权限请求块
   */
  appendPermissionRequestBlock: (requestId, sessionId, denials) => {
    const { currentMessage } = get()

    const permissionRequestBlock: import('../../types/chat').PermissionRequestBlock = {
      type: 'permission_request',
      id: requestId,
      sessionId,
      denials: denials.map(d => ({
        toolName: d.toolName,
        reason: d.reason,
        extra: d.extra,
      })),
      status: 'pending',
    }

    // 如果没有当前消息，创建一个新的
    if (!currentMessage) {
      const newMessage: CurrentAssistantMessage = {
        id: crypto.randomUUID(),
        blocks: [permissionRequestBlock],
        isStreaming: true,
      }
      set({
        currentMessage: newMessage,
        isStreaming: true,
        permissionRequestBlockMap: new Map([[requestId, 0]]),
        activePermissionRequestId: requestId,
      })
      return
    }

    // 添加权限请求块
    const updatedBlocks: ContentBlock[] = [...currentMessage.blocks, permissionRequestBlock]
    const blockIndex = updatedBlocks.length - 1

    // 更新 permissionRequestBlockMap
    const existingMap = get().permissionRequestBlockMap
    existingMap.set(requestId, blockIndex)

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
      permissionRequestBlockMap: existingMap,
      activePermissionRequestId: requestId,
    }))

    // 更新消息列表中的消息
    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 更新权限请求块状态
   */
  updatePermissionRequestBlock: (requestId, status, decision) => {
    const { currentMessage, permissionRequestBlockMap } = get()
    const blockIndex = permissionRequestBlockMap.get(requestId)

    if (!currentMessage || blockIndex === undefined) {
      console.warn('[EventChatStore] PermissionRequest block not found:', requestId)
      return
    }

    const block = currentMessage.blocks[blockIndex]
    if (!block || block.type !== 'permission_request') {
      console.warn('[EventChatStore] Invalid permission_request block at index:', blockIndex)
      return
    }

    // 更新权限请求块
    const updatedBlock: import('../../types/chat').PermissionRequestBlock = {
      ...block,
      status,
      decision,
    }

    const updatedBlocks = [...currentMessage.blocks]
    updatedBlocks[blockIndex] = updatedBlock

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
      // 如果权限请求已处理，清除活跃 ID
      activePermissionRequestId: status !== 'pending' ? null : state.activePermissionRequestId,
    }))

    // 更新消息列表中的消息
    get().updateCurrentAssistantMessage(updatedBlocks)
  },

  /**
   * 设置活跃权限请求
   */
  setActivePermissionRequest: (requestId) => {
    set({ activePermissionRequestId: requestId })
  },
})
