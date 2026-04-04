/**
 * 事件处理 Slice
 *
 * 负责事件监听初始化、消息发送、会话控制
 *
 * 已使用依赖注入模式解耦外部 Store：
 * - toolPanelActions: clearTools, addTool, updateTool
 * - workspaceActions: getCurrentWorkspace, getWorkspaces, getContextWorkspaces
 * - configActions: getConfig
 */

import { invoke } from '@tauri-apps/api/core'
import type { EventHandlerSlice } from './types'
import type { AISession } from '../../ai-runtime'
import type { UserChatMessage } from '../../types/chat'
import { handleAIEvent } from './utils'
import { getEventBus, isAIEvent } from '../../ai-runtime'
import { getEventRouter } from '../../services/eventRouter'
import { getEngine, listEngines } from '../../core/engine-bootstrap'
import { parseWorkspaceReferences, buildSystemPrompt } from '../../services/workspaceReference'
import { isTextFile } from '../../types/attachment'
import {
  toAppError,
  errorLogger,
  ErrorSource,
} from '../../types/errors'
import { createLogger } from '../../utils/logger'

const log = createLogger('EventChatStore')

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

    // 使用依赖注入获取工作区
    const workspaceActions = get().getWorkspaceActions()
    const currentWorkspace = workspaceActions?.getCurrentWorkspace()

    if (!currentWorkspace) {
      set({ error: '请先创建或选择一个工作区' })
      return
    }

    const actualWorkspaceDir = workspaceDir ?? currentWorkspace.path

    const { processedMessage } = parseWorkspaceReferences(
      content,
      workspaceActions?.getWorkspaces() || [],
      workspaceActions?.getContextWorkspaces() || [],
      workspaceActions?.getCurrentWorkspaceId() || null
    )

    const systemPrompt = buildSystemPrompt(
      workspaceActions?.getWorkspaces() || [],
      workspaceActions?.getContextWorkspaces() || [],
      workspaceActions?.getCurrentWorkspaceId() || null
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

    set({
      isStreaming: true,
      error: null,
      currentMessage: null,
      toolBlockMap: new Map(),
    })

    // 使用依赖注入清理工具面板
    const toolPanelActions = get().getToolPanelActions()
    toolPanelActions?.clearTools()

    try {
      // 使用依赖注入获取配置
      const configActions = get().getConfigActions()
      const config = configActions?.getConfig()
      const currentEngine = config?.defaultEngine || 'claude-code'

      // 检查是否是 Provider 引擎
      if (currentEngine.startsWith('provider-')) {
        await get().sendMessageToFrontendEngine(
          content,
          actualWorkspaceDir,
          systemPrompt,
          attachments
        )
      } else {
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
              systemPrompt: normalizedSystemPrompt,
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
              systemPrompt: normalizedSystemPrompt,
              workDir: actualWorkspaceDir,
              contextId: 'main',
              engineId: currentEngine,
              enableMcpTools: currentEngine === 'claude-code',
              attachments: attachmentsForBackend,
            },
          })
          set({ conversationId: newSessionId })

          // 同步 externalSessionId 到 SessionStore 并锁定工作区
          const sessionSyncActions = get().getSessionSyncActions()
          if (sessionSyncActions) {
            const activeSessionId = sessionSyncActions.getActiveSessionId()
            if (activeSessionId) {
              // 动态导入避免循环依赖
              import('../../stores/sessionStore')
                .then(({ useSessionStore }) => {
                  useSessionStore.getState().updateSessionExternalId(activeSessionId, newSessionId)
                  log.debug('已同步 externalSessionId 到 SessionStore', {
                    sessionId: activeSessionId,
                    externalSessionId: newSessionId
                  })
                })
                .catch((e) => {
                  log.warn('同步 externalSessionId 失败', { error: String(e) })
                })
            }
          }
        }
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

  sendMessageToFrontendEngine: async (content, workspaceDir, systemPrompt, attachments) => {
    // 使用依赖注入获取配置
    const configActions = get().getConfigActions()
    const config = configActions?.getConfig()

    if (!config?.openaiProviders || config.openaiProviders.length === 0) {
      set({ error: '未配置 OpenAI Provider，请在设置中添加', isStreaming: false })
      return
    }

    const activeProvider = config.activeProviderId
      ? config.openaiProviders.find(p => p.id === config.activeProviderId && p.enabled)
      : config.openaiProviders.find(p => p.enabled)

    if (!activeProvider) {
      set({ error: '没有启用的 OpenAI Provider，请在设置中启用', isStreaming: false })
      return
    }

    try {
      const engineId = `provider-${activeProvider.id}` as const

      const allEngines = listEngines()
      log.debug('当前注册的所有引擎', { engines: allEngines.map(e => e.id) })
      log.debug('尝试获取引擎 ID', { engineId })

      const engine = getEngine(engineId)

      if (!engine) {
        log.error('引擎未注册', new Error(`期望ID: ${engineId}, 实际注册的引擎: ${allEngines.map(e => e.id).join(', ')}`))
        throw new Error(`OpenAI Provider 引擎未注册，请重启应用`)
      }

      const { conversationId, providerSessionCache, currentConversationSeed } = get()

      let actualSeed = currentConversationSeed
      if (!actualSeed) {
        actualSeed = crypto.randomUUID()
        console.log('[eventChatStore] 生成新对话种子:', actualSeed)
        set({ currentConversationSeed: actualSeed })
      }

      const SESSION_TIMEOUT = 30 * 60 * 1000
      const canReuseSession =
        providerSessionCache?.session &&
        providerSessionCache.conversationSeed === actualSeed &&
        (Date.now() - providerSessionCache.lastUsed < SESSION_TIMEOUT)

      let session: AISession

      if (canReuseSession && providerSessionCache?.session) {
        console.log('[eventChatStore] 复用现有 Provider session')
        session = providerSessionCache.session

        set({
          providerSessionCache: {
            ...providerSessionCache,
            lastUsed: Date.now()
          }
        })
      } else {
        const sessionConfig = {
          workspaceDir,
          systemPrompt,
          timeout: 300000,
        }

        log.debug('创建新 Provider session', {
          workspaceDir,
          systemPrompt: systemPrompt ? `${systemPrompt.slice(0, 50)}...` : undefined,
          timeout: sessionConfig.timeout,
          reason: canReuseSession ? 'timeout' : 'new conversation'
        })

        session = engine.createSession(sessionConfig)

        set({
          providerSessionCache: {
            session,
            conversationId,
            conversationSeed: actualSeed,
            lastUsed: Date.now()
          }
        })
      }

      const task = {
        id: crypto.randomUUID(),
        kind: 'chat' as const,
        input: {
          prompt: content,
          attachments: attachments?.map(a => ({
            type: a.type,
            fileName: a.fileName,
            mimeType: a.mimeType,
            content: a.content,
          })),
        },
        engineId: 'deepseek',
      }

      const eventStream = session.run(task)
      const eventBus = getEventBus({ debug: false })

      for await (const event of eventStream) {
        eventBus.emit(event)
        handleAIEvent(event, set, get, workspaceDir)

        if (event.type === 'session_end' || event.type === 'error') {
          break
        }
      }
    } catch (e) {
      const appError = toAppError(e, {
        source: ErrorSource.AI,
        context: { workspaceDir }
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

  continueChat: async (prompt = '') => {
    const { conversationId } = get()
    if (!conversationId) {
      set({ error: '没有活动会话', isStreaming: false })
      return
    }

    const router = getEventRouter()
    await router.initialize()

    // 使用依赖注入获取工作区和配置
    const workspaceActions = get().getWorkspaceActions()
    const configActions = get().getConfigActions()
    const actualWorkspaceDir = workspaceActions?.getCurrentWorkspace()?.path
    const config = configActions?.getConfig()
    const currentEngine = config?.defaultEngine || 'claude-code'

    const normalizedPrompt = prompt
      .replace(/\r\n/g, '\\n')
      .replace(/\r/g, '\\n')
      .replace(/\n/g, '\\n')
      .trim()

    set({ isStreaming: true, error: null })

    if (currentEngine.startsWith('provider-')) {
      await get().sendMessageToFrontendEngine(
        normalizedPrompt,
        actualWorkspaceDir
      )
      return
    }

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

    const { conversationId, providerSessionCache } = get()

    // 使用依赖注入获取配置
    const configActions = get().getConfigActions()
    const config = configActions?.getConfig()
    const currentEngine = config?.defaultEngine || 'claude-code'

    if (currentEngine.startsWith('provider-')) {
      if (providerSessionCache?.session) {
        try {
          providerSessionCache.session.abort()
        } catch (e) {
          log.warn('Abort provider session failed', { error: String(e) })
        }
      }
      set({ isStreaming: false })
      get().finishMessage()
      return
    }

    if (!conversationId) return

    try {
      await invoke('interrupt_chat', { sessionId: conversationId, engineId: currentEngine })
      set({ isStreaming: false })
      get().finishMessage()
    } catch (e) {
      log.error('Interrupt failed', e as Error)
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
      isStreaming: true,
      error: null,
      currentMessage: null,
      toolBlockMap: new Map(),
    })

    // 清理工具面板
    const toolPanelActions = get().getToolPanelActions()
    toolPanelActions?.clearTools()

    try {
      const configActions = get().getConfigActions()
      const config = configActions?.getConfig()
      const currentEngine = config?.defaultEngine || 'claude-code'

      const workspaceActions = get().getWorkspaceActions()
      const currentWorkspace = workspaceActions?.getCurrentWorkspace()
      const actualWorkspaceDir = currentWorkspace?.path

      // 构建系统提示
      const systemPrompt = buildSystemPrompt(
        workspaceActions?.getWorkspaces() || [],
        workspaceActions?.getContextWorkspaces() || [],
        workspaceActions?.getCurrentWorkspaceId() || null
      )

      const normalizedSystemPrompt = systemPrompt
        .replace(/\r\n/g, '\\n')
        .replace(/\r/g, '\\n')
        .replace(/\n/g, '\\n')
        .trim()

      // 处理附件
      const attachmentsForBackend = userAttachments?.map((a: { type: string; fileName: string; mimeType?: string; content?: string }) => ({
        type: a.type,
        fileName: a.fileName,
        mimeType: a.mimeType,
        content: a.content,
      }))

      // 检查是否是 Provider 引擎
      if (currentEngine.startsWith('provider-')) {
        await get().sendMessageToFrontendEngine(
          userContent,
          actualWorkspaceDir,
          systemPrompt,
          userAttachments?.map((a: { id: string; type: string; fileName: string; fileSize: number; preview?: string }) => ({
            id: a.id,
            type: a.type,
            fileName: a.fileName,
            fileSize: a.fileSize,
            preview: a.preview,
          })) as import('../../types/attachment').Attachment[]
        )
      } else {
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
              systemPrompt: normalizedSystemPrompt,
              workDir: actualWorkspaceDir,
              contextId: 'main',
              engineId: currentEngine,
              enableMcpTools: currentEngine === 'claude-code',
              attachments: attachmentsForBackend,
            },
          })
        }
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
      isStreaming: true,
      error: null,
      currentMessage: null,
      toolBlockMap: new Map(),
    })

    // 清理工具面板
    const toolPanelActions = get().getToolPanelActions()
    toolPanelActions?.clearTools()

    try {
      const configActions = get().getConfigActions()
      const config = configActions?.getConfig()
      const currentEngine = config?.defaultEngine || 'claude-code'

      const workspaceActions = get().getWorkspaceActions()
      const currentWorkspace = workspaceActions?.getCurrentWorkspace()
      const actualWorkspaceDir = currentWorkspace?.path

      // 构建系统提示
      const systemPrompt = buildSystemPrompt(
        workspaceActions?.getWorkspaces() || [],
        workspaceActions?.getContextWorkspaces() || [],
        workspaceActions?.getCurrentWorkspaceId() || null
      )

      const normalizedSystemPrompt = systemPrompt
        .replace(/\r\n/g, '\\n')
        .replace(/\r/g, '\\n')
        .replace(/\n/g, '\\n')
        .trim()

      // 获取附件信息
      const userAttachments = (userMessage as UserChatMessage).attachments

      // 处理附件
      const attachmentsForBackend = userAttachments?.map((a: { type: string; fileName: string; mimeType?: string; content?: string }) => ({
        type: a.type,
        fileName: a.fileName,
        mimeType: a.mimeType,
        content: a.content,
      }))

      // 检查是否是 Provider 引擎
      if (currentEngine.startsWith('provider-')) {
        await get().sendMessageToFrontendEngine(
          newContent,
          actualWorkspaceDir,
          systemPrompt,
          userAttachments?.map((a: { id: string; type: string; fileName: string; fileSize: number; preview?: string }) => ({
            id: a.id,
            type: a.type,
            fileName: a.fileName,
            fileSize: a.fileSize,
            preview: a.preview,
          })) as import('../../types/attachment').Attachment[]
        )
      } else {
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
              systemPrompt: normalizedSystemPrompt,
              workDir: actualWorkspaceDir,
              contextId: 'main',
              engineId: currentEngine,
              enableMcpTools: currentEngine === 'claude-code',
              attachments: attachmentsForBackend,
            },
          })
        }
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
