/**
 * ConversationStore 工厂函数
 *
 * 每个会话创建独立的 Store 实例
 */

import { create, StoreApi, UseBoundStore } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { invoke } from '@tauri-apps/api/core'
import type { ConversationStore, ConversationState, StoreDeps } from './types'
import { handleAIEvent } from './eventHandler'
import { toAppError, ErrorSource } from '../../types/errors'
import { sessionStoreManager } from './sessionStoreManager'
import { parseWorkspaceReferences, buildWorkspaceSystemPrompt, getUserSystemPrompt } from '../../services/workspaceReference'

/**
 * 从用户消息生成标题
 * 取前 4 个字符作为标题，超出的部分用省略号
 */
function generateTitleFromMessage(content: string): string {
  // 移除换行和多余空格
  const cleanContent = content.replace(/\n/g, ' ').trim()
  // 取前 4 个字符
  const maxTitleLength = 4
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
    providerSessionCache: null,

    // 输入草稿
    inputDraft: {
      text: '',
      attachments: [],
    },

    // 工作区关联
    workspaceId: null,

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
          providerSessionCache: null,
        })
      },

      finishMessage: () => {
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
      appendTextBlock: (content) => {
        const { currentMessage, streamingUpdateCounter } = get()
        if (!currentMessage) {
          set({
            currentMessage: {
              id: crypto.randomUUID(),
              blocks: [{ type: 'text', content }],
              isStreaming: true,
            },
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        } else {
          const blocks = [...currentMessage.blocks]
          const lastBlock = blocks[blocks.length - 1]
          if (lastBlock?.type === 'text') {
            blocks[blocks.length - 1] = { ...lastBlock, content: lastBlock.content + content }
          } else {
            blocks.push({ type: 'text', content })
          }
          set({
            currentMessage: { ...currentMessage, blocks },
            streamingUpdateCounter: streamingUpdateCounter + 1,
          })
        }
      },

      appendThinkingBlock: (content) => {
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

      updateToolCallBlockFullContent: (toolId, fullContent) => {
        // Note: fullContent is stored at runtime but not in ToolCallBlock type
        const { currentMessage, toolBlockMap } = get()
        if (!currentMessage) return
        const idx = toolBlockMap.get(toolId)
        if (idx === undefined) return
        const blocks = [...currentMessage.blocks]
        if (blocks[idx]?.type === 'tool_call') {
          // Use type assertion to bypass TypeScript - fullContent is used at runtime
          const block = blocks[idx] as unknown as Record<string, unknown>
          block.fullContent = fullContent
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
          blocks[idx] = { ...blocks[idx], answer }
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
        set({
          messages,
          archivedMessages: [],
          conversationId,
          isStreaming: false,
          error: null,
          currentMessage: null,
          progressMessage: null,
        })
      },

      // ===== 事件处理 =====
      handleAIEvent: (event) => handleAIEvent(event, set, get),

      // ===== 主动操作 =====

      sendMessage: async (content, workspaceDir?, attachments?) => {
        const { conversationId, sessionId, messages } = get()
        const config = deps.getConfig()
        const engine = config?.defaultEngine || 'claude-code'

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
            preview: a.preview,
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
              },
            })
          } else {
            // 新会话
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

      continueChat: async (prompt = '') => {
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

      // ===== 资源清理 =====
      dispose: () => {
        const state = get()
        if (state.providerSessionCache?.session) {
          try {
            state.providerSessionCache.session.dispose()
          } catch (e) {
            console.warn('[ConversationStore] 清理 Session 失败:', e)
          }
        }
        // 重置状态
        set(createInitialState(state.sessionId))
      },
    }))
  )

  return store
}