/**
 * 事件处理 Slice
 *
 * 负责事件监听初始化、消息发送、会话控制
 *
 * 已使用依赖注入模式解耦外部 Store：
 * - workspaceActions: getCurrentWorkspace, getWorkspaces, getContextWorkspaces
 * - configActions: getConfig
 */

import { invoke } from '@tauri-apps/api/core'
import type { EventHandlerSlice } from './types'
import type { UserChatMessage } from '../../types/chat'
import type { Workspace } from '../../types'
import { handleAIEvent } from './utils'
import { getEventBus, isAIEvent } from '../../ai-runtime'
import { getEventRouter } from '../../services/eventRouter'
import { parseWorkspaceReferences, buildWorkspaceSystemPrompt, getUserSystemPrompt } from '../../services/workspaceReference'
import { isTextFile } from '../../types/attachment'
import {
  toAppError,
  errorLogger,
  ErrorSource,
} from '../../types/errors'
import { createLogger } from '../../utils/logger'
import { sessionStoreManager } from '../conversationStore/sessionStoreManager'

const log = createLogger('EventChatStore')

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
 * 获取会话有效工作区
 * 优先级：会话工作区 > 全局工作区
 */
function getEffectiveWorkspace(
  sessionSyncActions: {
    getActiveSessionId: () => string | null
    getSessionEffectiveWorkspace: (sessionId: string) => string | null
  } | undefined,
  workspaceActions: {
    getCurrentWorkspace: () => Workspace | null
    getWorkspaceById: (id: string) => Workspace | null
  } | undefined
): Workspace | null {
  // 1. 尝试获取会话有效工作区
  const activeSessionId = sessionSyncActions?.getActiveSessionId()
  if (activeSessionId) {
    const effectiveWorkspaceId = sessionSyncActions?.getSessionEffectiveWorkspace(activeSessionId)
    if (effectiveWorkspaceId) {
      const workspace = workspaceActions?.getWorkspaceById(effectiveWorkspaceId)
      if (workspace) {
        log.debug('使用会话有效工作区', { sessionId: activeSessionId, workspaceId: effectiveWorkspaceId, path: workspace.path })
        return workspace
      }
    }
  }

  // 2. 回退到全局工作区
  const globalWorkspace = workspaceActions?.getCurrentWorkspace()
  if (globalWorkspace) {
    log.debug('使用全局工作区', { path: globalWorkspace.path })
  }
  return globalWorkspace || null
}

/**
 * 获取会话关联工作区列表
 */
function getSessionContextWorkspaces(
  sessionSyncActions: {
    getActiveSessionId: () => string | null
    getSessionContextWorkspaceIds: (sessionId: string) => string[]
  } | undefined,
  workspaceActions: {
    getWorkspaces: () => Workspace[]
  } | undefined
): Workspace[] {
  const activeSessionId = sessionSyncActions?.getActiveSessionId()
  if (!activeSessionId) {
    return []
  }

  const contextIds = sessionSyncActions?.getSessionContextWorkspaceIds(activeSessionId) || []
  if (contextIds.length === 0) {
    return []
  }

  const allWorkspaces = workspaceActions?.getWorkspaces() || []
  const contextIdSet = new Set(contextIds)
  return allWorkspaces.filter(w => contextIdSet.has(w.id))
}

/**
 * 创建事件处理 Slice
 */
export const createEventHandlerSlice: EventHandlerSlice = (set, get) => ({
  // ===== 状态 =====
  _eventListenersInitialized: false,
  _eventListenersCleanup: null,

  // ===== 方法 =====

  initializeEventListeners: async (): Promise<() => void> => {
    const state = get()

    // 防止重复初始化
    if (state._eventListenersInitialized && state._eventListenersCleanup) {
      console.log('[EventChatStore] 事件监听器已初始化，跳过重复注册')
      return state._eventListenersCleanup
    }

    const cleanupCallbacks: Array<() => void> = []
    const eventBus = getEventBus({ debug: false })
    const router = getEventRouter()

    // 同步等待初始化完成
    await router.initialize()

    const unregister = router.register('main', (payload: unknown) => {
      try {
        if (!isAIEvent(payload)) {
          log.warn('收到非 AIEvent 类型的事件', { payload })
          return
        }
        const aiEvent = payload
        console.log('[EventChatStore] 收到 AIEvent:', aiEvent.type)

        // 使用依赖注入获取工作区路径
        const workspaceActions = get().getWorkspaceActions()
        const workspacePath = workspaceActions?.getCurrentWorkspace()?.path

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

    set({ _eventListenersInitialized: true })
    log.info('EventRouter 初始化完成，已注册 main 处理器')

    const cleanup = () => {
      cleanupCallbacks.forEach((cb) => cb())
      set({
        _eventListenersInitialized: false,
        _eventListenersCleanup: null
      })
    }

    set({ _eventListenersCleanup: cleanup })
    return cleanup
  },

  sendMessage: async (content, workspaceDir, attachments) => {
    // 停止之前的 TTS 播放
    import('../../services/ttsService').then(({ ttsService }) => {
      ttsService.stop()
    }).catch(() => {})

    const { conversationId } = get()

    const router = getEventRouter()
    await router.initialize()

    // 使用依赖注入获取会话有效工作区
    const sessionSyncActions = get().getSessionSyncActions()
    const workspaceActions = get().getWorkspaceActions()
    const currentWorkspace = getEffectiveWorkspace(sessionSyncActions, workspaceActions)

    if (!currentWorkspace) {
      set({ error: '请先创建或选择一个工作区' })
      return
    }

    const actualWorkspaceDir = workspaceDir ?? currentWorkspace.path

    // 获取会话关联工作区
    const contextWorkspaces = getSessionContextWorkspaces(sessionSyncActions, workspaceActions)

    const { processedMessage } = parseWorkspaceReferences(
      content,
      workspaceActions?.getWorkspaces() || [],
      contextWorkspaces,
      workspaceActions?.getCurrentWorkspaceId() || null
    )

    // 构建工作区系统提示词
    let workspacePrompt = ''
    let userPrompt: string | null = null
    if (currentWorkspace) {
      workspacePrompt = buildWorkspaceSystemPrompt(currentWorkspace, contextWorkspaces)
      userPrompt = getUserSystemPrompt(currentWorkspace, contextWorkspaces)
    }

    const normalizedMessage = processedMessage
      .replace(/\r\n/g, '\\n')
      .replace(/\r/g, '\\n')
      .replace(/\n/g, '\\n')
      .trim()

    const normalizedWorkspacePrompt = workspacePrompt
      .replace(/\r\n/g, '\\n')
      .replace(/\r/g, '\\n')
      .replace(/\n/g, '\\n')
      .trim()

    const normalizedUserPrompt = userPrompt
      ? userPrompt
          .replace(/\r\n/g, '\\n')
          .replace(/\r/g, '\\n')
          .replace(/\n/g, '\\n')
          .trim()
      : null

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
    const { messages } = get()
    if (messages.length === 1) {
      const activeSessionId = sessionStoreManager.getState().activeSessionId
      if (activeSessionId) {
        const title = generateTitleFromMessage(content)
        sessionStoreManager.getState().updateSessionTitle(activeSessionId, title)
      }
    }

    set({
      // 注意：isStreaming 不在这里设置，而是等待 session_start 事件设置
      // 这样确保 conversationId 在 isStreaming 之前就已有值，避免中断时的竞态条件
      error: null,
      currentMessage: null,
      toolBlockMap: new Map(),
    })

    
    try {
      // 使用依赖注入获取配置
      const configActions = get().getConfigActions()
      const config = configActions?.getConfig()
      const currentEngine = config?.defaultEngine || 'claude-code'

      // CLI 引擎
      let messageWithAttachments = normalizedMessage
      if (attachments && attachments.length > 0) {
          const nonImageAttachments = attachments.filter(a => a.type !== 'image')
          if (nonImageAttachments.length > 0) {
            const attachmentParts = nonImageAttachments.map(a => {
              const isText = isTextFile(a.mimeType, a.fileName)
              if (isText && a.content) {
                try {
                  const commaIndex = a.content.indexOf(',')
                  const base64Content = commaIndex !== -1 ? a.content.slice(commaIndex + 1) : a.content
                  const binaryString = atob(base64Content)
                  const bytes = new Uint8Array(binaryString.length)
                  for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i)
                  }
                  const decodedContent = new TextDecoder('utf-8').decode(bytes)
                  return `\n--- 文件: ${a.fileName} ---\n${decodedContent}\n--- 文件结束 ---`
                } catch {
                  return `[文件: ${a.fileName}]`
                }
              } else {
                return `[文件: ${a.fileName}]`
              }
            })
            messageWithAttachments = `${attachmentParts.join('\n')}\n\n${normalizedMessage}`
          }
        }

        // 准备附件数据
        const attachmentsForBackend = attachments?.map(a => ({
          type: a.type,
          fileName: a.fileName,
          mimeType: a.mimeType,
          content: a.content,
        }))

        if (conversationId) {
          await invoke('continue_chat', {
            sessionId: conversationId,
            message: messageWithAttachments,
            options: {
              appendSystemPrompt: normalizedWorkspacePrompt,
              systemPrompt: normalizedUserPrompt,
              workDir: actualWorkspaceDir,
              contextId: 'main',
              engineId: currentEngine,
              enableMcpTools: currentEngine === 'claude-code',
              attachments: attachmentsForBackend,
            },
          })
        } else {
          const newSessionId = await invoke<string>('start_chat', {
            message: messageWithAttachments,
            options: {
              appendSystemPrompt: normalizedWorkspacePrompt,
              systemPrompt: normalizedUserPrompt,
              workDir: actualWorkspaceDir,
              contextId: 'main',
              engineId: currentEngine,
              enableMcpTools: currentEngine === 'claude-code',
              attachments: attachmentsForBackend,
            },
          })
          set({ conversationId: newSessionId })
          // 注意：externalSessionId 的更新在 handleAIEvent 的 session_start 事件中处理
          // 因为 start_chat 返回的是临时 UUID，真实的 Claude Code sessionId 通过 session_start 事件传递
        }
    } catch (e) {
      const appError = toAppError(e, {
        source: ErrorSource.AI,
        context: { conversationId, workspaceDir: actualWorkspaceDir }
      })
      errorLogger.log(appError)

      set({
        error: appError.getUserMessage(),
        isStreaming: false,
        currentMessage: null,
        progressMessage: null,
      })
    }
  },

  sendMessageToFrontendEngine: async () => {
    // Removed: OpenAI Provider frontend engine
  },

  continueChat: async (prompt = '') => {
    const { conversationId } = get()
    if (!conversationId) {
      set({ error: '没有活动会话', isStreaming: false })
      return
    }

    const router = getEventRouter()
    await router.initialize()

    // 使用依赖注入获取会话有效工作区和配置
    const sessionSyncActions = get().getSessionSyncActions()
    const workspaceActions = get().getWorkspaceActions()
    const configActions = get().getConfigActions()
    const currentWorkspace = getEffectiveWorkspace(sessionSyncActions, workspaceActions)
    const actualWorkspaceDir = currentWorkspace?.path
    const config = configActions?.getConfig()
    const currentEngine = config?.defaultEngine || 'claude-code'

    const normalizedPrompt = prompt
      .replace(/\r\n/g, '\\n')
      .replace(/\r/g, '\\n')
      .replace(/\n/g, '\\n')
      .trim()

    // 注意：isStreaming 不在这里设置，而是等待 session_start 事件设置
    // 这样确保 conversationId 在 isStreaming 之前就已有值，避免中断时的竞态条件
    set({ error: null })

    try {
      await invoke('continue_chat', {
        sessionId: conversationId,
        message: normalizedPrompt,
        options: {
          workDir: actualWorkspaceDir,
          contextId: 'main',
          engineId: currentEngine,
        },
      })
    } catch (e) {
      const appError = toAppError(e, {
        source: ErrorSource.AI,
        context: { conversationId, workspaceDir: actualWorkspaceDir }
      })
      errorLogger.log(appError)

      set({
        error: appError.getUserMessage(),
        isStreaming: false,
        currentMessage: null,
        progressMessage: null,
      })
    }
  },

  interruptChat: async () => {
    // 停止 TTS 播放
    import('../../services/ttsService').then(({ ttsService }) => {
      ttsService.stop()
    }).catch(() => {})

    const { conversationId, isStreaming } = get()

    console.log('[EventChatStore] interruptChat:', { conversationId, isStreaming })

    if (!isStreaming) {
      console.log('[EventChatStore] 当前非流式状态，跳过中断')
      return
    }

    // 使用依赖注入获取配置
    const configActions = get().getConfigActions()
    const config = configActions?.getConfig()
    const currentEngine = config?.defaultEngine || 'claude-code'

    if (!conversationId) {
      console.warn('[EventChatStore] interruptChat: conversationId 为空，无法中断')
      set({ isStreaming: false })
      get().finishMessage()
      return
    }

    try {
      console.log('[EventChatStore] 调用后端 interrupt_chat:', { conversationId, engineId: currentEngine })
      await invoke('interrupt_chat', { sessionId: conversationId, engineId: currentEngine })
      console.log('[EventChatStore] 中断成功:', conversationId)
      set({ isStreaming: false })
      get().finishMessage()
    } catch (e) {
      log.error('Interrupt failed', e as Error)
      // 即使中断失败，也停止流式状态
      set({ isStreaming: false })
      get().finishMessage()
    }
  },

  /**
   * 重新生成助手回复
   * 找到对应的用户消息，删除原回复，重新发送
   */
  regenerateResponse: async (assistantMessageId: string) => {
    const { messages } = get()

    // 找到助手消息的索引
    const assistantIndex = messages.findIndex(m => m.id === assistantMessageId)
    if (assistantIndex === -1) {
      log.warn('[EventChatStore] 未找到助手消息', { assistantMessageId })
      return
    }

    const assistantMessage = messages[assistantIndex]
    if (assistantMessage.type !== 'assistant') {
      log.warn('[EventChatStore] 指定消息不是助手消息', { assistantMessageId })
      return
    }

    // 找到对应的用户消息（助手消息之前的最近一条用户消息）
    let userMessage: UserChatMessage | null = null
    for (let i = assistantIndex - 1; i >= 0; i--) {
      if (messages[i].type === 'user') {
        userMessage = messages[i] as UserChatMessage
        break
      }
    }

    if (!userMessage) {
      log.warn('[EventChatStore] 未找到对应的用户消息', { assistantMessageId })
      return
    }

    // 检查是否正在流式响应
    if (get().isStreaming) {
      log.warn('[EventChatStore] 正在流式响应中，无法重新生成')
      return
    }

    log.info('[EventChatStore] 重新生成回复', {
      userId: userMessage.id,
      assistantId: assistantMessageId,
      userContent: userMessage.content.substring(0, 50)
    })

    // 删除助手消息（保留用户消息）
    set((state) => ({
      messages: state.messages.filter(m => m.id !== assistantMessageId)
    }))

    // 保存用户消息内容和附件
    const userContent = userMessage.content
    const userAttachments = userMessage.attachments

    // 构建新的用户消息并添加到列表
    const newUserMessage: UserChatMessage = {
      id: crypto.randomUUID(),
      type: 'user',
      content: userContent,
      timestamp: new Date().toISOString(),
      attachments: userAttachments,
    }
    get().addMessage(newUserMessage)

    set({
      // 注意：isStreaming 不在这里设置，而是等待 session_start 事件设置
      // 这样确保 conversationId 在 isStreaming 之前就已有值，避免中断时的竞态条件
      error: null,
      currentMessage: null,
      toolBlockMap: new Map(),
    })

    try {
      const configActions = get().getConfigActions()
      const config = configActions?.getConfig()
      const currentEngine = config?.defaultEngine || 'claude-code'

      const sessionSyncActions = get().getSessionSyncActions()
      const workspaceActions = get().getWorkspaceActions()
      const currentWorkspace = getEffectiveWorkspace(sessionSyncActions, workspaceActions)
      const actualWorkspaceDir = currentWorkspace?.path

      // 获取会话关联工作区
      const contextWorkspaces = getSessionContextWorkspaces(sessionSyncActions, workspaceActions)

      // 构建工作区系统提示词
      const currentWorkspaceForPrompt = workspaceActions?.getWorkspaces()?.find(
        w => w.id === workspaceActions?.getCurrentWorkspaceId()
      )
      let workspacePrompt = ''
      let userPrompt: string | null = null
      if (currentWorkspaceForPrompt) {
        workspacePrompt = buildWorkspaceSystemPrompt(currentWorkspaceForPrompt, contextWorkspaces)
        userPrompt = getUserSystemPrompt(currentWorkspaceForPrompt, contextWorkspaces)
      }

      const normalizedWorkspacePrompt = workspacePrompt
        .replace(/\r\n/g, '\\n')
        .replace(/\r/g, '\\n')
        .replace(/\n/g, '\\n')
        .trim()

      const normalizedUserPrompt = userPrompt
        ? userPrompt
            .replace(/\r\n/g, '\\n')
            .replace(/\r/g, '\\n')
            .replace(/\n/g, '\\n')
            .trim()
        : null

      // 处理附件
      const attachmentsForBackend = userAttachments?.map((a: { type: string; fileName: string; mimeType?: string; content?: string }) => ({
        type: a.type,
        fileName: a.fileName,
        mimeType: a.mimeType,
        content: a.content,
      }))

      // CLI 引擎
      let messageWithAttachments = userContent
        .replace(/\r\n/g, '\\n')
        .replace(/\r/g, '\\n')
        .replace(/\n/g, '\\n')
        .trim()

      if (userAttachments && userAttachments.length > 0) {
        const nonImageAttachments = userAttachments.filter((a: { type: string }) => a.type !== 'image')
        if (nonImageAttachments.length > 0) {
          const attachmentParts = nonImageAttachments.map((a: { type: string; fileName: string; mimeType?: string; content?: string }) => {
            const isText = a.mimeType?.startsWith('text/') ||
                           a.fileName.endsWith('.txt') ||
                           a.fileName.endsWith('.md') ||
                           a.fileName.endsWith('.json')
            if (isText && a.content) {
              try {
                const commaIndex = a.content.indexOf(',')
                const base64Content = commaIndex !== -1 ? a.content.slice(commaIndex + 1) : a.content
                const binaryString = atob(base64Content)
                const bytes = new Uint8Array(binaryString.length)
                for (let i = 0; i < binaryString.length; i++) {
                  bytes[i] = binaryString.charCodeAt(i)
                }
                const decodedContent = new TextDecoder('utf-8').decode(bytes)
                return `\n--- 文件: ${a.fileName} ---\n${decodedContent}\n--- 文件结束 ---`
              } catch {
                return `[文件: ${a.fileName}]`
              }
            } else {
              return `[文件: ${a.fileName}]`
            }
          })
          messageWithAttachments = `${attachmentParts.join('\n')}\n\n${messageWithAttachments}`
        }
      }

      const { conversationId } = get()
      if (conversationId) {
        await invoke('continue_chat', {
          sessionId: conversationId,
          message: messageWithAttachments,
          options: {
            appendSystemPrompt: normalizedWorkspacePrompt,
            systemPrompt: normalizedUserPrompt,
            workDir: actualWorkspaceDir,
            contextId: 'main',
            engineId: currentEngine,
            enableMcpTools: currentEngine === 'claude-code',
            attachments: attachmentsForBackend,
          },
        })
      }
    } catch (e) {
      const appError = toAppError(e, {
        source: ErrorSource.AI,
        context: { action: 'regenerate' }
      })
      errorLogger.log(appError)

      set({
        error: appError.getUserMessage(),
        isStreaming: false,
        currentMessage: null,
        progressMessage: null,
      })
    }
  },

  /**
   * 编辑用户消息并重新发送
   * 更新用户消息内容，删除后续助手消息，重新发送
   */
  editAndResend: async (userMessageId: string, newContent: string) => {
    const { messages } = get()

    // 找到用户消息
    const userMessage = messages.find(m => m.id === userMessageId)
    if (!userMessage) {
      log.warn('[EventChatStore] 未找到用户消息', { userMessageId })
      return
    }

    if (userMessage.type !== 'user') {
      log.warn('[EventChatStore] 只能编辑用户消息', { userMessageId })
      return
    }

    // 检查是否正在流式响应
    if (get().isStreaming) {
      log.warn('[EventChatStore] 正在流式响应中，无法编辑')
      return
    }

    // 检查新内容是否为空
    if (!newContent.trim()) {
      log.warn('[EventChatStore] 消息内容不能为空')
      return
    }

    log.info('[EventChatStore] 编辑并重新发送消息', {
      userId: userMessageId,
      oldContent: (userMessage as UserChatMessage).content.substring(0, 50),
      newContent: newContent.substring(0, 50)
    })

    // 找到用户消息的索引
    const userIndex = messages.findIndex(m => m.id === userMessageId)

    // 删除用户消息之后的所有消息（包括助手回复）
    const messagesBeforeUser = messages.slice(0, userIndex + 1)

    // 更新用户消息内容
    const updatedUserMessage: UserChatMessage = {
      ...(userMessage as UserChatMessage),
      content: newContent,
      timestamp: new Date().toISOString(),
    }

    // 设置新消息列表（只保留更新后的用户消息和之前的消息）
    set({
      messages: [...messagesBeforeUser.slice(0, userIndex), updatedUserMessage],
      // 注意：isStreaming 不在这里设置，而是等待 session_start 事件设置
      // 这样确保 conversationId 在 isStreaming 之前就已有值，避免中断时的竞态条件
      error: null,
      currentMessage: null,
      toolBlockMap: new Map(),
    })

    try {
      const configActions = get().getConfigActions()
      const config = configActions?.getConfig()
      const currentEngine = config?.defaultEngine || 'claude-code'

      const sessionSyncActions = get().getSessionSyncActions()
      const workspaceActions = get().getWorkspaceActions()
      const currentWorkspace = getEffectiveWorkspace(sessionSyncActions, workspaceActions)
      const actualWorkspaceDir = currentWorkspace?.path

      // 获取会话关联工作区
      const contextWorkspaces = getSessionContextWorkspaces(sessionSyncActions, workspaceActions)

      // 构建系统提示词
      const workspaces = workspaceActions?.getWorkspaces() || []
      const currentWs = workspaces.find(w => w.id === workspaceActions?.getCurrentWorkspaceId())
      const workspacePrompt = currentWs ? buildWorkspaceSystemPrompt(currentWs, contextWorkspaces) : ''
      const userPrompt = currentWs ? getUserSystemPrompt(currentWs, contextWorkspaces) : null

      // 规范化系统提示词
      const normalizedWorkspacePrompt = workspacePrompt
        .replace(/\r\n/g, '\\n')
        .replace(/\r/g, '\\n')
        .replace(/\n/g, '\\n')
        .trim()
      const normalizedUserPrompt = userPrompt?.replace(/\r\n/g, '\\n').replace(/\r/g, '\\n').replace(/\n/g, '\\n').trim() ?? null

      // 获取附件信息
      const userAttachments = (userMessage as UserChatMessage).attachments

      // 处理附件
      const attachmentsForBackend = userAttachments?.map((a: { type: string; fileName: string; mimeType?: string; content?: string }) => ({
        type: a.type,
        fileName: a.fileName,
        mimeType: a.mimeType,
        content: a.content,
      }))

      // CLI 引擎
      let messageWithAttachments = newContent
        .replace(/\r\n/g, '\\n')
        .replace(/\r/g, '\\n')
        .replace(/\n/g, '\\n')
        .trim()

      if (userAttachments && userAttachments.length > 0) {
        const nonImageAttachments = userAttachments.filter((a: { type: string }) => a.type !== 'image')
        if (nonImageAttachments.length > 0) {
          const attachmentParts = nonImageAttachments.map((a: { type: string; fileName: string; mimeType?: string; content?: string }) => {
            const isText = a.mimeType?.startsWith('text/') ||
                           a.fileName.endsWith('.txt') ||
                           a.fileName.endsWith('.md') ||
                           a.fileName.endsWith('.json')
            if (isText && a.content) {
              try {
                const commaIndex = a.content.indexOf(',')
                const base64Content = commaIndex !== -1 ? a.content.slice(commaIndex + 1) : a.content
                const binaryString = atob(base64Content)
                const bytes = new Uint8Array(binaryString.length)
                for (let i = 0; i < binaryString.length; i++) {
                  bytes[i] = binaryString.charCodeAt(i)
                }
                const decodedContent = new TextDecoder('utf-8').decode(bytes)
                return `\n--- 文件: ${a.fileName} ---\n${decodedContent}\n--- 文件结束 ---`
              } catch {
                return `[文件: ${a.fileName}]`
              }
            } else {
              return `[文件: ${a.fileName}]`
            }
          })
          messageWithAttachments = `${attachmentParts.join('\n')}\n\n${messageWithAttachments}`
        }
      }

      const { conversationId } = get()
      if (conversationId) {
        await invoke('continue_chat', {
          sessionId: conversationId,
          message: messageWithAttachments,
          options: {
            appendSystemPrompt: normalizedWorkspacePrompt,
            systemPrompt: normalizedUserPrompt,
            workDir: actualWorkspaceDir,
            contextId: 'main',
            engineId: currentEngine,
            enableMcpTools: currentEngine === 'claude-code',
            attachments: attachmentsForBackend,
          },
        })
      }
    } catch (e) {
      const appError = toAppError(e, {
        source: ErrorSource.AI,
        context: { action: 'editAndResend' }
      })
      errorLogger.log(appError)

      set({
        error: appError.getUserMessage(),
        isStreaming: false,
        currentMessage: null,
        progressMessage: null,
      })
    }
  },
})
