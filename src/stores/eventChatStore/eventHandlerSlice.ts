/**
 * 事件处理 Slice
 *
 * 负责事件监听初始化、消息发送、会话控制
 */

import { invoke } from '@tauri-apps/api/core'
import type { EventHandlerSlice } from './types'
import { handleAIEvent } from './utils'
import { getEventBus } from '../../ai-runtime'
import { getEventRouter } from '../../services/eventRouter'
import { getEngine } from '../../core/engine-bootstrap'
import { useToolPanelStore } from '../toolPanelStore'
import { useWorkspaceStore } from '../workspaceStore'
import { useConfigStore } from '../configStore'
import { parseWorkspaceReferences, buildSystemPrompt } from '../../services/workspaceReference'
import { isTextFile } from '../../types/attachment'

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
        const aiEvent = payload as any
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

    set({ _eventListenersInitialized: true })
    console.log('[EventChatStore] EventRouter 初始化完成，已注册 main 处理器')

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

  sendMessage: async (content, workspaceDir, attachments, engineOptions) => {
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

    useToolPanelStore.getState().clearTools()

    try {
      const config = useConfigStore.getState().config
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

        // 转换引擎选项
        let cliArgs: string[] = []
        if (engineOptions && engineOptions.length > 0) {
          const { optionsToCliArgs } = await import('../../utils/engineOptions')
          cliArgs = optionsToCliArgs(currentEngine, engineOptions)
        }

        if (conversationId) {
          await invoke('continue_chat', {
            sessionId: conversationId,
            message: messageWithAttachments,
            systemPrompt: normalizedSystemPrompt,
            workDir: actualWorkspaceDir,
            contextId: 'main',
            engineId: currentEngine,
            attachments: attachmentsForBackend,
            cliArgs,
          })
        } else {
          const newSessionId = await invoke<string>('start_chat', {
            message: messageWithAttachments,
            systemPrompt: normalizedSystemPrompt,
            workDir: actualWorkspaceDir,
            contextId: 'main',
            engineId: currentEngine,
            attachments: attachmentsForBackend,
            cliArgs,
          })
          set({ conversationId: newSessionId })
        }
      }
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : '发送消息失败',
        isStreaming: false,
        currentMessage: null,
        progressMessage: null,
      })

      console.error('[EventChatStore] 发送消息失败:', e)
    }
  },

  sendMessageToFrontendEngine: async (content, workspaceDir, systemPrompt, attachments) => {
    const config = useConfigStore.getState().config

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

      const { listEngines } = await import('../../core/engine-bootstrap')
      const allEngines = listEngines()
      console.log('[EventChatStore] 当前注册的所有引擎:', allEngines.map(e => e.id))
      console.log('[EventChatStore] 尝试获取引擎 ID:', engineId)

      const engine = getEngine(engineId)

      if (!engine) {
        console.error('[EventChatStore] 引擎未注册. 期望ID:', engineId, '实际注册的引擎:', allEngines.map(e => e.id))
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

      let session: any

      if (canReuseSession) {
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

        console.log('[eventChatStore] 创建新 Provider session:', {
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
      set({
        error: e instanceof Error ? e.message : '发送消息失败',
        isStreaming: false,
        currentMessage: null,
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
        workDir: actualWorkspaceDir,
        contextId: 'main',
        engineId: currentEngine,
      })
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : '继续对话失败',
        isStreaming: false,
        currentMessage: null,
        progressMessage: null,
      })

      console.error('[EventChatStore] 继续对话失败:', e)
    }
  },

  interruptChat: async () => {
    const { conversationId, providerSessionCache } = get()

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
      console.error('[EventChatStore] Interrupt failed:', e)
    }
  },
})
