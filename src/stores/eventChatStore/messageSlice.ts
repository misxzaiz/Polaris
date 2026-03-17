/**
 * 消息状态 Slice
 *
 * 负责消息的 CRUD 操作和流式消息构建
 */

import type { MessageSlice, CurrentAssistantMessage } from './types'
import type { ContentBlock, ToolCallBlock } from '../../types'
import { useToolPanelStore } from '../toolPanelStore'
import { MESSAGE_ARCHIVE_THRESHOLD, STORAGE_VERSION, STORAGE_KEY } from './types'
import { generateToolSummary, calculateDuration } from '../../utils/toolSummary'

/**
 * 创建消息状态 Slice
 */
export const createMessageSlice: MessageSlice = (set, get) => ({
  // ===== 状态 =====
  messages: [],
  archivedMessages: [],
  currentMessage: null,
  toolBlockMap: new Map(),
  streamingUpdateCounter: 0,

  // ===== 方法 =====

  addMessage: (message) => {
    set((state) => {
      const newMessages = [...state.messages, message]

      if (newMessages.length > MESSAGE_ARCHIVE_THRESHOLD) {
        const archiveCount = newMessages.length - state.maxMessages
        const toArchive = newMessages.slice(0, archiveCount)
        const remaining = newMessages.slice(archiveCount)

        // 归档时立即保存，防止页面刷新时丢失
        setTimeout(() => {
          try {
            const currentState = get()
            const data = {
              version: STORAGE_VERSION,
              timestamp: new Date().toISOString(),
              messages: currentState.messages,
              archivedMessages: currentState.archivedMessages,
              conversationId: currentState.conversationId,
            }
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data))
            console.log('[EventChatStore] 归档消息已保存')
          } catch (e) {
            console.error('[EventChatStore] 保存归档失败:', e)
          }
        }, 0)

        return {
          messages: remaining,
          archivedMessages: toArchive,
        }
      }

      return { messages: newMessages }
    })

    // 只在非归档情况下调用 saveToStorage()，避免重复保存
    const { messages } = get()
    if (messages.length <= MESSAGE_ARCHIVE_THRESHOLD) {
      get().saveToStorage()
    }
  },

  clearMessages: () => {
    // 清理 Provider Session
    const { providerSessionCache, _eventListenersCleanup } = get()
    if (providerSessionCache?.session) {
      try {
        providerSessionCache.session.dispose()
      } catch (e) {
        console.warn('[EventChatStore] 清理 Session 失败:', e)
      }
    }

    // 清理事件监听器（如果存在）
    if (_eventListenersCleanup) {
      try {
        _eventListenersCleanup()
      } catch (e) {
        console.warn('[EventChatStore] 清理事件监听器失败:', e)
      }
    }

    // 清理文件读取缓存
    const { clearFileReadCache } = require('./utils') as typeof import('./utils')
    clearFileReadCache()

    set({
      messages: [],
      archivedMessages: [],
      isArchiveExpanded: false,
      conversationId: null,
      currentConversationSeed: null,
      progressMessage: null,
      currentMessage: null,
      toolBlockMap: new Map(),
      providerSessionCache: null,
      _eventListenersInitialized: false,
      _eventListenersCleanup: null,
    })
    useToolPanelStore.getState().clearTools()
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

    get().saveToStorage()
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
    if (lastBlock && lastBlock.type === 'text') {
      const updatedBlocks: ContentBlock[] = [...currentMessage.blocks]
      updatedBlocks[updatedBlocks.length - 1] = {
        type: 'text',
        content: (lastBlock as any).content + content,
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
    const toolPanelStore = useToolPanelStore.getState()
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
      toolPanelStore.addTool({
        id: toolId,
        name: toolName,
        status: 'pending',
        input,
        startedAt: now,
      })

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
    toolPanelStore.addTool({
      id: toolId,
      name: toolName,
      status: 'pending',
      input,
      startedAt: now,
    })

    // 更新进度消息
    set({ progressMessage: generateToolSummary(toolName, input, 'pending') })
  },

  /**
   * 更新工具调用块状态
   */
  updateToolCallBlock: (toolId, status, output, error) => {
    const { currentMessage, toolBlockMap } = get()
    const toolPanelStore = useToolPanelStore.getState()
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
    toolPanelStore.updateTool(toolId, {
      status,
      output: output ? String(output) : undefined,
      completedAt: now,
    })

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
})
