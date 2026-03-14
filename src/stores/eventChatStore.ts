/**
 * 事件驱动的 Chat Store
 *
 * 完全基于 AIEvent 和 EventBus 的聊天状态管理。
 * 支持新的分层对话流消息类型（ToolMessage、ToolGroupMessage）。
 *
 * 架构说明：
 * 1. Tauri 'chat-event' → EventRouter → AIEvent（后端已转换）
 * 2. EventBus.emit() → DeveloperPanel（调试面板）
 * 3. handleAIEvent() → 本地状态更新
 */

import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import type { ChatMessage, AssistantChatMessage, UserChatMessage, SystemChatMessage, ContentBlock, ToolCallBlock, ToolStatus } from '../types'
import type { AIEvent } from '../ai-runtime'
import { useToolPanelStore } from './toolPanelStore'
import { useWorkspaceStore } from './workspaceStore'
import { useConfigStore } from './configStore'
import { useGitStore } from './gitStore'
import {
  generateToolSummary,
  calculateDuration,
} from '../utils/toolSummary'
import { parseWorkspaceReferences, buildSystemPrompt } from '../services/workspaceReference'
import { getEventBus } from '../ai-runtime'
import { TokenBuffer } from '../utils/tokenBuffer'
import { getIFlowHistoryService } from '../services/iflowHistoryService'
import { getClaudeCodeHistoryService } from '../services/claudeCodeHistoryService'
import { extractEditDiff, isEditTool } from '../utils/diffExtractor'
import { getEngine } from '../core/engine-bootstrap'
import { getEventRouter } from '../services/eventRouter'

/** 最大保留消息数量 */
const MAX_MESSAGES = 500

/** 消息保留阈值 */
const MESSAGE_ARCHIVE_THRESHOLD = 550

/** 每批次加载的消息数量 */
const BATCH_LOAD_COUNT = 20

/** 本地存储键 */
const STORAGE_KEY = 'event_chat_state_backup'
const STORAGE_VERSION = '5' // 版本升级：添加历史管理功能

/** 会话历史存储键 */
const SESSION_HISTORY_KEY = 'event_chat_session_history'
/** 最大会话历史数量 */
const MAX_SESSION_HISTORY = 50

/** 事件监听器初始化状态（防止重复注册） */
let eventListenersInitialized = false
let eventListenersCleanup: (() => void) | null = null

/**
 * 历史会话记录（localStorage 存储）
 */
interface HistoryEntry {
  id: string
  title: string
  timestamp: string
  messageCount: number
  engineId: 'claude-code' | 'iflow' | 'codex' | `provider-${string}`
  data: {
    messages: ChatMessage[]
    archivedMessages: ChatMessage[]
  }
}

/**
 * 统一的历史条目（包含 localStorage、IFlow 和 Claude Code 原生的会话）
 */
export interface UnifiedHistoryItem {
  id: string
  title: string
  timestamp: string
  messageCount: number
  engineId: 'claude-code' | 'iflow' | 'codex' | `provider-${string}`
  source: 'local' | 'iflow' | 'claude-code-native' | 'codex'
  fileSize?: number
  inputTokens?: number
  outputTokens?: number
  /** Claude Code 项目目录名（如 D--space-app-Polaris） */
  projectPath?: string
}

/**
 * 当前正在构建的 Assistant 消息
 */
interface CurrentAssistantMessage {
  id: string
  blocks: ContentBlock[]
  isStreaming: true
}

// ============================================================================
// 统一状态更新层：AIEvent → 本地状态
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
function readFileWithCache(filePath: string): Promise<string> {
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
 * 处理 AIEvent 更新本地状态
 *
 * 这是统一的状态更新入口，所有 AIEvent 都通过这里更新本地状态。
 * 与 convertStreamEventToAIEvents() 配合使用，实现事件流统一处理。
 *
 * 设计说明：
 * - 只处理与本地状态相关的 AIEvent
 * - 不再直接处理 StreamEvent，避免重复逻辑
 * - 与 EventBus 分离，Store 只负责状态管理
 *
 * @param event 要处理的 AIEvent
 * @param storeSet Zustand 的 set 函数
 * @param storeGet Zustand 的 get 函数
 */
function handleAIEvent(
  event: AIEvent,
  storeSet: (partial: Partial<EventChatState> | ((state: EventChatState) => Partial<EventChatState>)) => void,
  storeGet: () => EventChatState,
  workspacePath?: string
): void {
  // 🔍 强制诊断日志
  console.log('🔍 [handleAIEvent] 收到事件:', event.type, {
    hasToken: event.type === 'token',
    tokenLength: event.type === 'token' ? event.value?.length : 0,
    timestamp: new Date().toISOString()
  })

  const state = storeGet()

  switch (event.type) {
    case 'session_start':
      storeSet({ conversationId: event.sessionId, isStreaming: true })
      console.log('[EventChatStore] Session started:', event.sessionId)
      useToolPanelStore.getState().clearTools()
      break

    case 'session_end':
      state.finishMessage()
      storeSet({ isStreaming: false, progressMessage: null })
      console.log('[EventChatStore] Session ended:', event.reason)
      
      // 会话结束时刷新 Git 状态（防抖）
      if (workspacePath) {
        const gitStore = useGitStore.getState()
        gitStore.refreshStatusDebounced(workspacePath).catch(err => {
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

    case 'tool_call_start':
      state.appendToolCallBlock(
        event.callId || crypto.randomUUID(),
        event.tool,
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

    case 'tool_call_end':
      if (!event.callId) {
        console.warn('[EventChatStore] tool_call_end 事件缺少 callId，工具状态无法更新:', event.tool)
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
        const state = storeGet()
        const blockIndex = state.toolBlockMap.get(event.callId)

        if (state.currentMessage && blockIndex !== undefined) {
          const block = state.currentMessage.blocks[blockIndex]

          if (block && block.type === 'tool_call' && isEditTool(block.name)) {
            const diffData = extractEditDiff(block)
            if (diffData) {
              state.updateToolCallBlockDiff(event.callId, diffData)

              // 修复：降级策略也使用缓存读取，避免重复请求
              if (!block.diffData?.fullOldContent && diffData.filePath) {
                // 捕获 callId，避免异步回调中的类型问题
                const callId = event.callId
                readFileWithCache(diffData.filePath)
                  .then(fullContent => {
                    // 再次检查是否还需要设置（避免竞态）
                    const currentState = storeGet()
                    const blockIdx = currentState.toolBlockMap.get(callId)
                    if (blockIdx !== undefined) {
                      const currentBlock = currentState.currentMessage?.blocks[blockIdx]
                      if (currentBlock?.type === 'tool_call' && !currentBlock.diffData?.fullOldContent) {
                        console.log('[EventChatStore] 降级策略：从文件系统读取完整内容')
                        currentState.updateToolCallBlockFullContent(callId, fullContent)
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
      if (workspacePath) {
        const gitStore = useGitStore.getState()
        gitStore.refreshStatusDebounced(workspacePath).catch(err => {
          console.warn('[EventChatStore] 工具完成后刷新 Git 状态失败:', err)
        })
      }
      break

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

    default:
      console.log('[EventChatStore] 未处理的 AIEvent 类型:', (event as { type: string }).type)
  }
}

/**
 * 事件驱动 Chat State
 */
interface EventChatState {
  /** 消息列表（使用新的 ChatMessage 类型） */
  messages: ChatMessage[]
  /** 归档的消息列表 */
  archivedMessages: ChatMessage[]
  /** 归档是否展开 */
  isArchiveExpanded: boolean
  /** 当前会话 ID */
  conversationId: string | null
  /** 当前对话的唯一标识（用于区分不同对话） */
  currentConversationSeed: string | null
  /** 是否正在流式传输 */
  isStreaming: boolean
  /** 错误 */
  error: string | null
  /** 最大消息数配置 */
  maxMessages: number
  /** 是否已初始化 */
  isInitialized: boolean
  /** 是否正在加载历史 */
  isLoadingHistory: boolean
  /** 当前进度消息 */
  progressMessage: string | null

  /** 当前正在构建的 Assistant 消息 */
  currentMessage: CurrentAssistantMessage | null
  /** 工具调用块映射 (toolUseId -> blockIndex) */
  toolBlockMap: Map<string, number>

  /** Token Buffer - 用于批量处理流式 token */
  tokenBuffer: TokenBuffer | null

  /** OpenAI Provider Session 缓存 */
  providerSessionCache: {
    session: any | null
    conversationId: string | null
    conversationSeed: string | null
    lastUsed: number
  } | null

  /** 流式更新计数器 - 用于强制触发React重新渲染 */
  streamingUpdateCounter: number

  /** 添加消息 */
  addMessage: (message: ChatMessage) => void
  /** 清空消息 */
  clearMessages: () => void
  /** 设置会话 ID */
  setConversationId: (id: string | null) => void
  /** 设置流式状态 */
  setStreaming: (streaming: boolean) => void
  /** 完成当前消息 */
  finishMessage: () => void
  /** 设置错误 */
  setError: (error: string | null) => void
  /** 设置进度消息 */
  setProgressMessage: (message: string | null) => void

  /** 添加文本块 */
  appendTextBlock: (content: string) => void
  /** 添加思考过程块 */
  appendThinkingBlock: (content: string) => void
  /** 添加工具调用块 */
  appendToolCallBlock: (toolId: string, toolName: string, input: Record<string, unknown>) => void
  /** 更新工具调用块状态 */
  updateToolCallBlock: (toolId: string, status: ToolStatus, output?: string, error?: string) => void
  /** 更新工具调用块的 Diff 数据 */
  updateToolCallBlockDiff: (toolId: string, diffData: { oldContent: string; newContent: string; filePath: string }) => void
  /** 更新工具调用块的完整文件内容（用于撤销） */
  updateToolCallBlockFullContent: (toolId: string, fullContent: string) => void
  /** 更新当前 Assistant 消息（内部方法） */
  updateCurrentAssistantMessage: (blocks: ContentBlock[]) => void

  /** 初始化事件监听 */
  initializeEventListeners: () => Promise<() => void>

  /** 发送消息 */
  sendMessage: (content: string, workspaceDir?: string, attachments?: import('../types/attachment').Attachment[]) => Promise<void>
  /** 使用前端引擎发送消息（OpenAI Provider） */
  sendMessageToFrontendEngine: (content: string, workspaceDir?: string, systemPrompt?: string, attachments?: import('../types/attachment').Attachment[]) => Promise<void>
  /** 继续会话 */
  continueChat: (prompt?: string) => Promise<void>
  /** 中断会话 */
  interruptChat: () => Promise<void>

  /** 设置最大消息数 */
  setMaxMessages: (max: number) => void
  /** 切换归档展开状态 */
  toggleArchive: () => void
  /** 加载归档消息（一次性全部加载） */
  loadArchivedMessages: () => void
  /** 分批加载归档消息 */
  loadMoreArchivedMessages: (count?: number) => void

  /** 保存状态到本地存储 */
  saveToStorage: () => void
  /** 从本地存储恢复状态 */
  restoreFromStorage: () => boolean

  /** 保存会话到历史 */
  saveToHistory: (title?: string) => void

  /** 获取统一会话历史（包含 localStorage 和 IFlow） */
  getUnifiedHistory: () => Promise<UnifiedHistoryItem[]>

  /** 从历史恢复会话 */
  restoreFromHistory: (sessionId: string, engineId?: 'claude-code' | 'iflow' | 'codex' | `provider-${string}`, projectPath?: string) => Promise<boolean>

  /** 删除历史会话 */
  deleteHistorySession: (sessionId: string, source?: 'local' | 'iflow' | 'codex') => void

  /** 清空历史 */
  clearHistory: () => void
}

/**
 * 事件驱动的 Chat Store
 */
export const useEventChatStore = create<EventChatState>((set, get) => ({
  messages: [],
  archivedMessages: [],
  isArchiveExpanded: false,
  conversationId: null,
  currentConversationSeed: null,
  isStreaming: false,
  error: null,
  maxMessages: MAX_MESSAGES,
  isInitialized: false,
  isLoadingHistory: false,
  progressMessage: null,
  currentMessage: null,
  toolBlockMap: new Map(),
  tokenBuffer: null,
  providerSessionCache: null,
  streamingUpdateCounter: 0, // 🔧 新增：流式更新计数器

  addMessage: (message) => {
    set((state) => {
      const newMessages = [...state.messages, message]

      if (newMessages.length > MESSAGE_ARCHIVE_THRESHOLD) {
        const archiveCount = newMessages.length - state.maxMessages
        const toArchive = newMessages.slice(0, archiveCount)
        const remaining = newMessages.slice(archiveCount)

        // 修复：归档时立即保存，防止页面刷新时丢失
        // 归档后直接返回，不再调用 saveToStorage()，避免重复保存
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

    // 修复：只在非归档情况下调用 saveToStorage()，避免重复保存
    const { messages } = get()
    if (messages.length <= MESSAGE_ARCHIVE_THRESHOLD) {
      get().saveToStorage()
    }
  },

  clearMessages: () => {
    // 清理 TokenBuffer
    const { tokenBuffer, providerSessionCache } = get()
    if (tokenBuffer) {
      tokenBuffer.destroy()
    }

    // 清理 Provider Session
    if (providerSessionCache?.session) {
      try {
        providerSessionCache.session.dispose()
      } catch (e) {
        console.warn('[EventChatStore] 清理 Session 失败:', e)
      }
    }

    set({
      messages: [],
      archivedMessages: [],
      isArchiveExpanded: false,
      conversationId: null,
      currentConversationSeed: null, // 重置对话种子
      progressMessage: null,
      currentMessage: null,
      toolBlockMap: new Map(),
      tokenBuffer: null,
      providerSessionCache: null, // 清理 session 缓存
    })
    useToolPanelStore.getState().clearTools()
  },

  setConversationId: (id) => {
    const { providerSessionCache, conversationId: currentId } = get()

    // 如果切换到不同的对话，清理 Provider Session
    if (providerSessionCache && currentId !== id) {
      console.log('[EventChatStore] 切换对话，清理 Provider session')
      try {
        providerSessionCache.session.dispose()
      } catch (e) {
        console.warn('[EventChatStore] 清理 Session 失败:', e)
      }

      set({
        conversationId: id,
        currentConversationSeed: null, // 重置对话种子
        providerSessionCache: null
      })
    } else {
      set({ conversationId: id })
    }
  },

  setStreaming: (streaming) => {
    set({ isStreaming: streaming })
  },

  /**
   * 完成当前消息
   * 将 currentMessage 标记为完成，并清空
   */
  finishMessage: () => {
    const { tokenBuffer } = get()

    // 先刷新并结束缓冲，确保最后一批内容写入 currentMessage
    if (tokenBuffer) {
      tokenBuffer.end()
    }

    const { currentMessage, messages } = get()

    if (currentMessage) {
      // 标记消息为完成状态
      const completedMessage: AssistantChatMessage = {
        id: currentMessage.id,
        type: 'assistant',
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
          tokenBuffer: null,
          isStreaming: false,  // 修复：一次性设置所有状态，避免覆盖
        }))
      } else {
        // 如果消息不在列表中（理论上不应该发生），添加它
        set((state) => ({
          messages: [...state.messages, completedMessage],
          currentMessage: null,
          progressMessage: null,
          tokenBuffer: null,
          isStreaming: false,  // 修复：一次性设置所有状态，避免覆盖
        }))
      }
    } else {
      // 即使没有 currentMessage，也要重置状态
      set({ isStreaming: false })
    }

    get().saveToStorage()
  },

  setError: (error) => {
    set({ error })
  },

  setProgressMessage: (message) => {
    set({ progressMessage: message })
  },

  /**
   * 添加文本块到当前消息（使用 TokenBuffer 批量优化）
   *
   * 性能优化：使用 TokenBuffer 将多个 token 批量处理，
   * 减少 90% 的状态更新和重渲染次数。
   */
  appendTextBlock: (content) => {
    const { currentMessage, tokenBuffer } = get()

    // 🔍 强制诊断日志（确保在控制台能看到）
    console.log('🔍 [appendTextBlock] ==================== 开始 ====================')
    console.log('🔍 [appendTextBlock] currentMessage 存在:', !!currentMessage)
    console.log('🔍 [appendTextBlock] tokenBuffer 存在:', !!tokenBuffer)
    console.log('🔍 [appendTextBlock] content 长度:', content.length)
    console.log('🔍 [appendTextBlock] content 预览:', content.slice(0, 100))
    console.log('🔍 [appendTextBlock] 时间:', new Date().toISOString())
    console.log('🔍 [appendTextBlock] isStreaming:', get().isStreaming)

    // 如果没有当前消息，创建一个新的（首次调用）
    if (!currentMessage) {
      console.log('[appendTextBlock] 创建新消息')
      const textBlock: ContentBlock = { type: 'text', content }
      const newMessage: CurrentAssistantMessage = {
        id: crypto.randomUUID(),
        blocks: [textBlock],
        isStreaming: true,
      }
      set({
        currentMessage: newMessage,
        isStreaming: true,
      })
      // 注意：不再调用 addMessage，由 displayMessages 统一处理
      // 避免与 displayMessages 的 useMemo 产生竞争条件导致消息重复

      // 创建 TokenBuffer 用于后续的批量处理
      const newBuffer = new TokenBuffer((batchedContent) => {
        // 🔍 强制诊断日志
        console.log('🔍 [TokenBuffer.flush()] ==================== 刷新 ====================')
        console.log('🔍 [TokenBuffer.flush()] batchedContent 长度:', batchedContent.length)
        console.log('🔍 [TokenBuffer.flush()] batchedContent 预览:', batchedContent.slice(0, 100))
        console.log('🔍 [TokenBuffer.flush()] 时间:', new Date().toISOString())

        // TokenBuffer 刷新时的回调 - 批量更新内容
        // 性能优化：流式阶段只更新 currentMessage，不更新 messages 数组
        // 避免 50ms 一次的整个消息列表重渲染
        const state = get()
        const msg = state.currentMessage
        if (!msg) {
          console.log('⚠️ [TokenBuffer.flush()] 没有找到 currentMessage，跳过更新')
          return
        }

        const lastBlock = msg.blocks[msg.blocks.length - 1]
        if (lastBlock && lastBlock.type === 'text') {
          // 追加到现有文本块
          const updatedBlocks: ContentBlock[] = [...msg.blocks]
          updatedBlocks[updatedBlocks.length - 1] = {
            type: 'text',
            content: (lastBlock as any).content + batchedContent,
          }
          console.log('✅ [TokenBuffer.flush()] 更新文本块，新总长度:', (updatedBlocks[updatedBlocks.length - 1] as any).content.length)
          set((state) => ({
            currentMessage: state.currentMessage
              ? { ...state.currentMessage, blocks: updatedBlocks }
              : null,
            streamingUpdateCounter: (state.streamingUpdateCounter || 0) + 1, // 🔧 强制触发更新
          }))
          // 注意：流式阶段不调用 updateCurrentAssistantMessage
          // 让组件从 currentMessage 读取流式内容，避免频繁更新 messages 数组
        } else {
          // 最后一块不是文本块（如 tool_call），创建新的文本块
          // 这处理了工具调用后继续有文本的场景
          const textBlock: ContentBlock = { type: 'text', content: batchedContent }
          const updatedBlocks: ContentBlock[] = [...msg.blocks, textBlock]
          set((state) => ({
            currentMessage: state.currentMessage
              ? { ...state.currentMessage, blocks: updatedBlocks }
              : null,
            streamingUpdateCounter: (state.streamingUpdateCounter || 0) + 1, // 🔧 强制触发更新
          }))
          // 注意：流式阶段不调用 updateCurrentAssistantMessage
        }
      }, { maxDelay: 50, maxSize: 500 })

      set({ tokenBuffer: newBuffer })
    } else if (tokenBuffer) {
      // 有 TokenBuffer，使用批量处理
      tokenBuffer.append(content)
    } else {
      // 降级：直接更新（用于非流式场景）
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
        }))
        get().updateCurrentAssistantMessage(updatedBlocks)
      } else {
        const textBlock: ContentBlock = { type: 'text', content }
        const updatedBlocks: ContentBlock[] = [...currentMessage.blocks, textBlock]
        set((state) => ({
          currentMessage: state.currentMessage
            ? { ...state.currentMessage, blocks: updatedBlocks }
            : null,
        }))
        get().updateCurrentAssistantMessage(updatedBlocks)
      }
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

    // 优化：直接修改 toolBlockMap 而非创建新 Map
    // Zustand 支持 Map 的直接修改（只要返回的是同一个 Map 引用）
    const existingMap = get().toolBlockMap
    existingMap.set(toolId, blockIndex)

    set((state) => ({
      currentMessage: state.currentMessage
        ? { ...state.currentMessage, blocks: updatedBlocks }
        : null,
      // 保持相同的 Map 引用，避免不必要的重渲染
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
    const summary = generateToolSummary(toolName, input, 'pending')
    set({ progressMessage: summary })
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
    const summary = generateToolSummary(block.name, block.input, status)
    set({ progressMessage: summary })
  },

  /**
   * 更新工具调用块的 Diff 数据
   * 注意：使用合并模式，保留已有的 fullOldContent
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
        ...block.diffData,  // 保留现有字段（特别是 fullOldContent）
        ...diffData,         // 覆盖新字段
      } as ToolCallBlock['diffData'],
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
  updateCurrentAssistantMessage: (blocks: ContentBlock[]) => {
    const { currentMessage } = get()
    if (!currentMessage) return

    set((state) => ({
      messages: state.messages.map(msg =>
        msg.id === currentMessage!.id
          ? { ...msg, blocks } as AssistantChatMessage
          : msg
      ),
    }))
  },

  /**
   * 初始化事件监听
   * 这是事件驱动架构的核心方法
   *
   * 架构说明（优化后）：
   * 1. 监听 Tauri 'chat-event'（后端已转换为 AIEvent）
   * 2. eventBus.emit() 发送到 EventBus（DeveloperPanel 订阅）
   * 3. handleAIEvent() 更新本地状态
   *
   * 优化效果：
   * - 后端统一转换，前端无需再做解析
   * - 统一使用 AIEvent 进行状态更新
   * - 代码简洁，职责分离
   */
  initializeEventListeners: async (): Promise<() => void> => {
    // 防止重复初始化
    if (eventListenersInitialized && eventListenersCleanup) {
      console.log('[EventChatStore] 事件监听器已初始化，跳过重复注册')
      return eventListenersCleanup
    }

    const cleanupCallbacks: Array<() => void> = []

    const eventBus = getEventBus({ debug: false })

    const router = getEventRouter()

    // 同步等待初始化完成，确保 register 在监听开始前完成
    await router.initialize()

    const unregister = router.register('main', (payload: unknown) => {
      try {
        // 后端已发送标准 AIEvent，直接使用
        const aiEvent = payload as AIEvent

        console.log('[EventChatStore] 收到 AIEvent:', aiEvent.type)

        const workspacePath = useWorkspaceStore.getState().getCurrentWorkspace()?.path

        try {
          eventBus.emit(aiEvent)
        } catch (e) {
          console.error('[EventChatStore] EventBus 发送失败:', e)
        }

        handleAIEvent(aiEvent, set, get, workspacePath)
      } catch (e) {
        console.error('[EventChatStore] 处理事件失败:', e)
      }
    })
    cleanupCallbacks.push(unregister)
    eventListenersInitialized = true
    console.log('[EventChatStore] EventRouter 初始化完成，已注册 main 处理器')

    const cleanup = () => {
      cleanupCallbacks.forEach((cb) => cb())
      eventListenersInitialized = false
      eventListenersCleanup = null
    }
    eventListenersCleanup = cleanup
    return cleanup
  },

  sendMessage: async (content, workspaceDir, attachments) => {
    const { conversationId } = get()

    const router = getEventRouter()
    await router.initialize()

    const workspaceStore = useWorkspaceStore.getState()
    const currentWorkspace = workspaceStore.getCurrentWorkspace()

    if (!currentWorkspace) {
      set({ error: '请先创建或选择一个工作区' })
      return
    }

    const actualWorkspaceDir = workspaceDir ?? currentWorkspace.path

    const { processedMessage } = parseWorkspaceReferences(
      content,
      workspaceStore.workspaces,
      workspaceStore.getContextWorkspaces(),
      workspaceStore.currentWorkspaceId
    )

    const systemPrompt = buildSystemPrompt(
      workspaceStore.workspaces,
      workspaceStore.getContextWorkspaces(),
      workspaceStore.currentWorkspaceId
    )

    const normalizedMessage = processedMessage
      .replace(/\r\n/g, '\\n')
      .replace(/\r/g, '\\n')
      .replace(/\n/g, '\\n')
      .trim()

    const normalizedSystemPrompt = systemPrompt
      .replace(/\r\n/g, '\\n')
      .replace(/\r/g, '\\n')
      .replace(/\n/g, '\\n')
      .trim()

    // 构建用户消息，包含附件信息
    const userMessage: UserChatMessage = {
      id: crypto.randomUUID(),
      type: 'user',
      content,
      timestamp: new Date().toISOString(),
      // 附件信息（用于显示）
      attachments: attachments?.map(a => ({
        id: a.id,
        type: a.type,
        fileName: a.fileName,
        fileSize: a.fileSize,
        preview: a.preview,
      })),
    }
    get().addMessage(userMessage)

    set({
      isStreaming: true,
      error: null,
      currentMessage: null,
      toolBlockMap: new Map(),
    })

    useToolPanelStore.getState().clearTools()

    try {
      const config = useConfigStore.getState().config
      const currentEngine = config?.defaultEngine || 'claude-code'

      // 检查是否是 Provider 引擎（格式: provider-{id}）
      if (currentEngine.startsWith('provider-')) {
        await get().sendMessageToFrontendEngine(
          content,
          actualWorkspaceDir,
          systemPrompt,
          attachments
        )
      } else {
        // CLI 引擎：将附件转换为文本描述
        let messageWithAttachments = normalizedMessage
        if (attachments && attachments.length > 0) {
          const attachmentDescriptions = attachments.map(a => {
            if (a.type === 'image') {
              return `[图片: ${a.fileName}]`
            } else {
              return `[文件: ${a.fileName}]`
            }
          }).join('\n')
          messageWithAttachments = `${attachmentDescriptions}\n\n${normalizedMessage}`
        }

        const { invoke } = await import('@tauri-apps/api/core')

        if (conversationId) {
          await invoke('continue_chat', {
            sessionId: conversationId,
            message: messageWithAttachments,
            systemPrompt: normalizedSystemPrompt,
            workDir: actualWorkspaceDir,
            contextId: 'main',
            engineId: currentEngine,
          })
        } else {
          const newSessionId = await invoke<string>('start_chat', {
            message: messageWithAttachments,
            systemPrompt: normalizedSystemPrompt,
            workDir: actualWorkspaceDir,
            contextId: 'main',
            engineId: currentEngine,
          })
          set({ conversationId: newSessionId })
        }
      }
    } catch (e) {
      const { tokenBuffer } = get()
      if (tokenBuffer) {
        tokenBuffer.destroy()
      }

      set({
        error: e instanceof Error ? e.message : '发送消息失败',
        isStreaming: false,
        currentMessage: null,
        tokenBuffer: null,
        progressMessage: null,
      })

      console.error('[EventChatStore] 发送消息失败:', e)
    }
  },

  /**
   * 使用前端引擎（OpenAI Provider）发送消息
   *
   * 直接迭代 session.run() 返回的事件流，与 AgentRunner 模式一致。
   *
   * @param content - 原始消息内容
   * @param workspaceDir - 工作区路径
   * @param systemPrompt - 系统提示词
   * @param attachments - 附件列表
   */
  sendMessageToFrontendEngine: async (content: string, workspaceDir?: string, systemPrompt?: string, attachments?: import('../types/attachment').Attachment[]) => {
    const config = useConfigStore.getState().config

    // 检查是否有配置的 OpenAI Providers
    if (!config?.openaiProviders || config.openaiProviders.length === 0) {
      set({ error: '未配置 OpenAI Provider，请在设置中添加', isStreaming: false })
      return
    }

    // 查找启用的 Provider
    const activeProvider = config.activeProviderId
      ? config.openaiProviders.find(p => p.id === config.activeProviderId && p.enabled)
      : config.openaiProviders.find(p => p.enabled)

    if (!activeProvider) {
      set({ error: '没有启用的 OpenAI Provider，请在设置中启用', isStreaming: false })
      return
    }

    try {
      const engineId = `provider-${activeProvider.id}` as const

      // 调试：列出所有已注册的引擎
      const { listEngines } = await import('../core/engine-bootstrap')
      const allEngines = listEngines()
      console.log('[EventChatStore] 当前注册的所有引擎:', allEngines.map(e => e.id))
      console.log('[EventChatStore] 尝试获取引擎 ID:', engineId)

      const engine = getEngine(engineId)

      if (!engine) {
        console.error('[EventChatStore] 引擎未注册. 期望ID:', engineId, '实际注册的引擎:', allEngines.map(e => e.id))
        throw new Error(`OpenAI Provider 引擎未注册，请重启应用\n期望ID: ${engineId}\n已注册: ${allEngines.map(e => e.id).join(', ')}`)
      }

      const { conversationId, providerSessionCache, currentConversationSeed } = get()

      // 如果没有会话种子，生成新的（表示这是一个新对话）
      let actualSeed = currentConversationSeed
      if (!actualSeed) {
        actualSeed = crypto.randomUUID()
        console.log('[eventChatStore] 生成新对话种子:', actualSeed)
        set({ currentConversationSeed: actualSeed })
      }

      // 检查是否可以复用现有 session
      // 使用 conversationSeed 而不是 conversationId，因为 Provider 不使用后端会话 ID
      const SESSION_TIMEOUT = 30 * 60 * 1000 // 30 分钟超时
      const canReuseSession =
        providerSessionCache?.session &&
        providerSessionCache.conversationSeed === actualSeed &&
        (Date.now() - providerSessionCache.lastUsed < SESSION_TIMEOUT)

      let session: any

      if (canReuseSession) {
        // 复用现有 session，保留消息历史
        console.log('[eventChatStore] 复用现有 Provider session')
        session = providerSessionCache.session

        // 更新最后使用时间
        set({
          providerSessionCache: {
            ...providerSessionCache,
            lastUsed: Date.now()
          }
        })
      } else {
        // 创建新 session
        const sessionConfig = {
          workspaceDir,
          systemPrompt,
          timeout: 300000, // 5 分钟（与 maxTokens 32K 匹配）
        }

        console.log('[eventChatStore] 创建新 Provider session:', {
          workspaceDir,
          systemPrompt: systemPrompt ? `${systemPrompt.slice(0, 50)}...` : undefined,
          timeout: sessionConfig.timeout,
          reason: canReuseSession ? 'timeout' : 'new conversation'
        })

        session = engine.createSession(sessionConfig)

        // 缓存新 session
        set({
          providerSessionCache: {
            session,
            conversationId,
            conversationSeed: actualSeed,
            lastUsed: Date.now()
          }
        })
      }

      // 构建任务，包含附件
      const task = {
        id: crypto.randomUUID(),
        kind: 'chat' as const,
        input: {
          prompt: content,
          // 传递附件给 session
          attachments: attachments?.map(a => ({
            type: a.type,
            fileName: a.fileName,
            mimeType: a.mimeType,
            content: a.content, // base64 data URL
          })),
        },
        engineId: 'deepseek',
      }

      // 执行任务并迭代事件流
      const eventStream = session.run(task)

      const eventBus = getEventBus({ debug: false })

      for await (const event of eventStream) {
        eventBus.emit(event)
        // 直接使用 handleAIEvent 处理事件
        handleAIEvent(event, set, get, workspaceDir)

        // 检查是否应该结束
        if (event.type === 'session_end' || event.type === 'error') {
          break
        }
      }
    } catch (e) {
      const { tokenBuffer } = get()
      if (tokenBuffer) {
        tokenBuffer.destroy()
      }

      set({
        error: e instanceof Error ? e.message : '发送消息失败',
        isStreaming: false,
        currentMessage: null,
        tokenBuffer: null,
        progressMessage: null,
      })

      console.error('[EventChatStore] 前端引擎发送消息失败:', e)
    }
  },

  continueChat: async (prompt = '') => {
    const { conversationId } = get()
    if (!conversationId) {
      set({ error: '没有活动会话', isStreaming: false })
      return
    }

    const router = getEventRouter()
    await router.initialize()

    const actualWorkspaceDir = useWorkspaceStore.getState().getCurrentWorkspace()?.path
    const config = useConfigStore.getState().config
    const currentEngine = config?.defaultEngine || 'claude-code'

    const normalizedPrompt = prompt
      .replace(/\r\n/g, '\\n')
      .replace(/\r/g, '\\n')
      .replace(/\n/g, '\\n')
      .trim()

    set({ isStreaming: true, error: null })

    // Provider 引擎使用前端发送
    if (currentEngine.startsWith('provider-')) {
      await get().sendMessageToFrontendEngine(
        normalizedPrompt,
        actualWorkspaceDir
      )
      return
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('continue_chat', {
        sessionId: conversationId,
        message: normalizedPrompt,
        workDir: actualWorkspaceDir,
        contextId: 'main',
        engineId: currentEngine,
      })
    } catch (e) {
      const { tokenBuffer } = get()
      if (tokenBuffer) {
        tokenBuffer.destroy()
      }

      set({
        error: e instanceof Error ? e.message : '继续对话失败',
        isStreaming: false,
        currentMessage: null,
        tokenBuffer: null,
        progressMessage: null,
      })

      console.error('[EventChatStore] 继续对话失败:', e)
    }
  },

  interruptChat: async () => {
    const { conversationId, tokenBuffer, providerSessionCache } = get()

    // 修复：使用 destroy() 而不是 end()，确保释放 TokenBuffer 资源
    if (tokenBuffer) {
      tokenBuffer.destroy()
    }

    const config = useConfigStore.getState().config
    const currentEngine = config?.defaultEngine || 'claude-code'

    if (currentEngine.startsWith('provider-')) {
      if (providerSessionCache?.session) {
        try {
          providerSessionCache.session.abort()
        } catch (e) {
          console.warn('[EventChatStore] Abort provider session failed:', e)
        }
      }
      set({ isStreaming: false, tokenBuffer: null })
      get().finishMessage()
      return
    }

    if (!conversationId) return

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('interrupt_chat', { sessionId: conversationId, engineId: currentEngine })
      set({ isStreaming: false, tokenBuffer: null }) // 同时清空 tokenBuffer 引用
      get().finishMessage()
    } catch (e) {
      console.error('[EventChatStore] Interrupt failed:', e)
    }
  },

  setMaxMessages: (max) => {
    set({ maxMessages: Math.max(100, max) })

    const { messages, archivedMessages } = get()
    if (messages.length > max) {
      const archiveCount = messages.length - max
      const toArchive = messages.slice(0, archiveCount)
      const remaining = messages.slice(archiveCount)

      set({
        messages: remaining,
        archivedMessages: [...toArchive, ...archivedMessages] as ChatMessage[],
      })
    }
  },

  toggleArchive: () => {
    set((state) => ({
      isArchiveExpanded: !state.isArchiveExpanded,
    }))
  },

  loadArchivedMessages: () => {
    const { archivedMessages } = get()
    if (archivedMessages.length === 0) return

    set({
      messages: [...archivedMessages, ...get().messages],
      archivedMessages: [],
      isArchiveExpanded: false,
    })
  },

  /**
   * 分批加载归档消息
   * @param count 要加载的消息数量，默认 BATCH_LOAD_COUNT
   */
  loadMoreArchivedMessages: (count: number = BATCH_LOAD_COUNT) => {
    const { archivedMessages, messages } = get()
    if (archivedMessages.length === 0) return

    // 从归档末尾取 count 条消息（最新的归档消息）
    const loadCount = Math.min(count, archivedMessages.length)
    const toLoad = archivedMessages.slice(-loadCount)
    const remaining = archivedMessages.slice(0, -loadCount)

    console.log(`[EventChatStore] 分批加载 ${loadCount} 条消息，剩余 ${remaining.length} 条归档`)

    set({
      // 将加载的消息添加到 messages 开头
      messages: [...toLoad, ...messages],
      archivedMessages: remaining,
    })

    // 保存状态
    get().saveToStorage()
  },

  saveToStorage: () => {
    try {
      const state = get()
      const data = {
        version: STORAGE_VERSION,
        timestamp: new Date().toISOString(),
        messages: state.messages,
        archivedMessages: state.archivedMessages,
        conversationId: state.conversationId,
      }
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch (e) {
      console.error('[EventChatStore] 保存状态失败:', e)
    }
  },

  restoreFromStorage: () => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY)
      if (!stored) return false

      const data = JSON.parse(stored)

      if (data.version !== STORAGE_VERSION) {
        console.warn('[EventChatStore] 存储版本不匹配，忽略')
        return false
      }

      const storedTime = new Date(data.timestamp).getTime()
      const now = Date.now()
      if (now - storedTime > 60 * 60 * 1000) {
        sessionStorage.removeItem(STORAGE_KEY)
        return false
      }

      set({
        messages: data.messages || [],
        archivedMessages: data.archivedMessages || [],
        conversationId: data.conversationId || null,
        isStreaming: false,
        isInitialized: true,
        currentMessage: null,
        toolBlockMap: new Map(),
      })

      sessionStorage.removeItem(STORAGE_KEY)
      return true
    } catch (e) {
      console.error('[EventChatStore] 恢复状态失败:', e)
      return false
    }
  },

  /**
   * 保存会话到历史
   */
  saveToHistory: (title?: string) => {
    try {
      const state = get()
      if (!state.conversationId || state.messages.length === 0) return

      // 获取当前引擎 ID
      const config = useConfigStore.getState().config
      const engineId: 'claude-code' | 'iflow' | 'codex' | `provider-${string}` = (config?.defaultEngine || 'claude-code') as 'claude-code' | 'iflow' | 'codex' | `provider-${string}`

      // 获取现有历史
      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const history = historyJson ? JSON.parse(historyJson) : []

      // 生成标题（从第一条用户消息提取）
      const firstUserMessage = state.messages.find(m => m.type === 'user')
      let sessionTitle = title || '新对话'
      if (!title && firstUserMessage && 'content' in firstUserMessage) {
        sessionTitle = (firstUserMessage.content as string).slice(0, 50) + '...'
      }

      // 创建历史记录
      const historyEntry: HistoryEntry = {
        id: state.conversationId,
        title: sessionTitle,
        timestamp: new Date().toISOString(),
        messageCount: state.messages.length,
        engineId,
        data: {
          messages: state.messages,
          archivedMessages: state.archivedMessages,
        }
      }

      // 移除同ID的旧记录
      const filteredHistory = history.filter((h: HistoryEntry) => h.id !== state.conversationId)

      // 添加新记录到开头
      filteredHistory.unshift(historyEntry)

      // 限制历史数量
      const limitedHistory = filteredHistory.slice(0, MAX_SESSION_HISTORY)

      localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(limitedHistory))
      console.log('[EventChatStore] 会话已保存到历史:', sessionTitle, '引擎:', engineId)
    } catch (e) {
      console.error('[EventChatStore] 保存历史失败:', e)
    }
  },

  /**
   * 获取统一会话历史（包含 localStorage、IFlow 和 Claude Code 原生）
   */
  getUnifiedHistory: async () => {
    const items: UnifiedHistoryItem[] = []
    const iflowService = getIFlowHistoryService()
    const claudeCodeService = getClaudeCodeHistoryService()
    const workspaceStore = useWorkspaceStore.getState()
    const currentWorkspace = workspaceStore.getCurrentWorkspace()

    try {
      // 1. 获取 localStorage 中的会话历史
      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const localHistory: HistoryEntry[] = historyJson ? JSON.parse(historyJson) : []

      for (const h of localHistory) {
        items.push({
          id: h.id,
          title: h.title,
          timestamp: h.timestamp,
          messageCount: h.messageCount,
          engineId: h.engineId || 'claude-code',
          source: 'local',
        })
      }

      // 2. 获取 Claude Code 原生会话列表
      try {
        const claudeCodeSessions = await claudeCodeService.listSessions(
          currentWorkspace?.path
        )
        for (const session of claudeCodeSessions) {
          // 排除已经存在的会话
          if (!items.find(item => item.id === session.sessionId)) {
            items.push({
              id: session.sessionId,
              title: session.firstPrompt || '无标题会话',
              timestamp: session.modified || session.created || new Date().toISOString(),
              messageCount: session.messageCount,
              engineId: 'claude-code',
              source: 'claude-code-native',
              fileSize: session.fileSize,
              projectPath: session.projectPath, // 保存 Claude Code 项目目录名
            })
          }
        }
      } catch (e) {
        console.warn('[EventChatStore] 获取 Claude Code 原生会话失败:', e)
      }

      // 3. 获取 IFlow 会话列表（如果当前工作区存在）
      try {
        const iflowSessions = await iflowService.listSessions()
        for (const session of iflowSessions) {
          // 排除已经存在的会话（避免重复）
          if (!items.find(item => item.id === session.sessionId)) {
            items.push({
              id: session.sessionId,
              title: session.title,
              timestamp: session.updatedAt,
              messageCount: session.messageCount,
              engineId: 'iflow',
              source: 'iflow',
              fileSize: session.fileSize,
              inputTokens: session.inputTokens,
              outputTokens: session.outputTokens,
            })
          }
        }
      } catch (e) {
        console.warn('[EventChatStore] 获取 IFlow 会话失败:', e)
      }

      // 4. 获取 Codex 会话列表
      try {
        const { listCodexSessions } = await import('../services/tauri')
        const codexSessions = await listCodexSessions(currentWorkspace?.path || '')
        for (const session of codexSessions) {
          // 排除已经存在的会话
          if (!items.find(item => item.id === session.sessionId)) {
            items.push({
              id: session.sessionId,
              title: session.title,
              timestamp: session.updatedAt,
              messageCount: session.messageCount,
              engineId: 'codex',
              source: 'codex',
              fileSize: session.fileSize,
            })
          }
        }
      } catch (e) {
        console.warn('[EventChatStore] 获取 Codex 会话失败:', e)
      }

      // 5. 按时间戳排序
      items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

      return items
    } catch (e) {
      console.error('[EventChatStore] 获取统一历史失败:', e)
      return []
    }
  },

  /**
   * 从历史恢复会话
   */
  restoreFromHistory: async (sessionId: string, engineId?: 'claude-code' | 'iflow' | 'codex' | `provider-${string}`, projectPath?: string) => {
    try {
      set({ isLoadingHistory: true })

      // 1. 先尝试从 localStorage 恢复
      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const localHistory = historyJson ? JSON.parse(historyJson) : []
      const localSession = localHistory.find((h: HistoryEntry) => h.id === sessionId)

      if (localSession) {
        set({
          messages: localSession.data.messages || [],
          archivedMessages: localSession.data.archivedMessages || [],
          conversationId: localSession.id,
          isStreaming: false,
          error: null,
        })

        get().saveToStorage()
        console.log('[EventChatStore] 已从本地历史恢复会话:', localSession.title)
        return true
      }

      // 2. 尝试从 Claude Code 原生历史恢复
      if (!engineId || engineId === 'claude-code') {
        const claudeCodeService = getClaudeCodeHistoryService()

        const messages = await claudeCodeService.getSessionHistory(
          sessionId,
          projectPath // 使用传入的 projectPath（Claude Code 项目目录名）
        )

        if (messages.length > 0) {
          // 使用新的 convertToChatMessages 方法，直接获取包含 blocks 的 ChatMessage
          const chatMessages = claudeCodeService.convertToChatMessages(messages)
          const toolCalls = claudeCodeService.extractToolCalls(messages)

          // 设置工具面板
          useToolPanelStore.getState().clearTools()
          for (const tool of toolCalls) {
            useToolPanelStore.getState().addTool(tool)
          }

          set({
            messages: chatMessages,
            archivedMessages: [],
            conversationId: sessionId,
            isStreaming: false,
            error: null,
          })

          console.log('[EventChatStore] 已从 Claude Code 原生历史恢复会话:', sessionId)
          return true
        }
      }

      // 3. 如果指定了 IFlow 或未指定，尝试从 IFlow 恢复
      if (!engineId || engineId === 'iflow') {
        const iflowService = getIFlowHistoryService()
        const messages = await iflowService.getSessionHistory(sessionId)

        if (messages.length > 0) {
          const convertedMessages = iflowService.convertMessagesToFormat(messages)
          const toolCalls = iflowService.extractToolCalls(messages)

          // 设置工具面板
          useToolPanelStore.getState().clearTools()
          for (const tool of toolCalls) {
            useToolPanelStore.getState().addTool(tool)
          }

          // 将 Message 格式转换为 ChatMessage 格式
          const chatMessages: ChatMessage[] = convertedMessages.map((msg): ChatMessage => {
            if (msg.role === 'user') {
              return {
                id: msg.id,
                type: 'user',
                content: msg.content,
                timestamp: msg.timestamp,
              } as UserChatMessage
            } else if (msg.role === 'assistant') {
              return {
                id: msg.id,
                type: 'assistant',
                blocks: [
                  { type: 'text', content: msg.content }
                ],
                timestamp: msg.timestamp,
                content: msg.content,
                toolSummary: msg.toolSummary,
              } as AssistantChatMessage
            } else {
              return {
                id: msg.id,
                type: 'system',
                content: msg.content,
                timestamp: msg.timestamp,
              } as SystemChatMessage
            }
          })

          set({
            messages: chatMessages,
            archivedMessages: [],
            conversationId: sessionId,
            isStreaming: false,
            error: null,
          })

          console.log('[EventChatStore] 已从 IFlow 恢复会话:', sessionId)
          return true
        }
      }

      // 4. 如果指定了 Codex，尝试从 Codex 恢复
      if (engineId === 'codex') {
        const { getCodexSessionHistory } = await import('../services/tauri')
        const messages = await getCodexSessionHistory(sessionId)

        if (messages && messages.length > 0) {
          // 将 Codex 历史消息转换为 ChatMessage 格式
          const chatMessages: ChatMessage[] = messages.map((msg): ChatMessage => {
            if (msg.type === 'user') {
              return {
                id: msg.id,
                type: 'user',
                content: msg.content,
                timestamp: msg.timestamp,
              } as UserChatMessage
            } else {
              return {
                id: msg.id,
                type: 'assistant',
                blocks: [
                  { type: 'text', content: msg.content }
                ],
                timestamp: msg.timestamp,
                content: msg.content,
              } as AssistantChatMessage
            }
          })

          set({
            messages: chatMessages,
            archivedMessages: [],
            conversationId: sessionId,
            isStreaming: false,
            error: null,
          })

          console.log('[EventChatStore] 已从 Codex 恢复会话:', sessionId, '消息数:', chatMessages.length)
          return true
        }
      }

      return false
    } catch (e) {
      console.error('[EventChatStore] 从历史恢复失败:', e)
      return false
    } finally {
      set({ isLoadingHistory: false })
    }
  },

  /**
   * 删除历史会话
   */
  deleteHistorySession: (sessionId: string, source?: 'local' | 'iflow' | 'codex') => {
    try {
      if (source === 'iflow' || (!source && sessionId.startsWith('session-'))) {
        // IFlow 会话不能删除，只能忽略
        console.log('[EventChatStore] IFlow 会话无法删除，仅作忽略:', sessionId)
        return
      }
      if (source === 'codex') {
        // Codex 会话不能删除，只能忽略
        console.log('[EventChatStore] Codex 会话无法删除，仅作忽略:', sessionId)
        return
      }

      // 删除本地历史
      const historyJson = localStorage.getItem(SESSION_HISTORY_KEY)
      const history = historyJson ? JSON.parse(historyJson) : []

      const filteredHistory = history.filter((h: HistoryEntry) => h.id !== sessionId)
      localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(filteredHistory))
    } catch (e) {
      console.error('[EventChatStore] 删除历史会话失败:', e)
    }
  },

  /**
   * 清空历史
   */
  clearHistory: () => {
    try {
      localStorage.removeItem(SESSION_HISTORY_KEY)
      console.log('[EventChatStore] 历史已清空')
    } catch (e) {
      console.error('[EventChatStore] 清空历史失败:', e)
    }
  },
}))
