/**
 * useActiveSession - 统一的活跃会话状态 Hook
 *
 * 封装 sessionStoreManager，提供统一的活跃会话状态接口
 * 用于简化 UI 组件迁移到新架构
 *
 * 使用方法：
 * 1. useActiveSession() - 获取完整状态和操作
 * 2. useActiveSessionMessages() - 只订阅消息
 * 3. useActiveSessionStreaming() - 只订阅流式状态
 */

import { useMemo, useCallback, useSyncExternalStore, useRef } from 'react'
import { useStore } from 'zustand'
import {
  sessionStoreManager,
  useActiveSessionId,
} from './sessionStoreManager'
import { useWorkspaceStore } from '../workspaceStore'
import type { ConversationStore, ConversationState, ConversationStoreInstance } from './types'
import type { ContentBlock } from '../../types'

/**
 * 订阅活跃会话的特定状态
 *
 * 内部使用 useSyncExternalStore 确保响应式更新
 * 使用 useRef 缓存返回值，避免 getSnapshot 返回不稳定引用导致无限循环
 */
function useActiveSessionSelector<T>(
  selector: (state: ConversationState) => T,
  defaultValue: T
): T {
  const sessionId = useActiveSessionId()
  const stores = useStore(sessionStoreManager, (state) => state.stores)

  const store = sessionId ? stores.get(sessionId) : null

  // 缓存上次的值，确保引用稳定
  const cachedValueRef = useRef<T>(defaultValue)
  const cachedStoreRef = useRef<typeof store>(null)

  // 使用 getSnapshot 和 subscribe 模式
  const getSnapshot = useCallback(() => {
    if (!store) {
      // store 不存在时返回稳定的默认值
      return defaultValue
    }

    const newValue = selector(store.getState())

    // 检查值是否真正变化（引用比较或浅比较）
    // 对于原始类型直接比较，对于对象/数组检查引用
    if (
      cachedStoreRef.current === store &&
      cachedValueRef.current === newValue
    ) {
      // store 相同且值引用相同，返回缓存值
      return cachedValueRef.current
    }

    // 值变化了，更新缓存
    cachedStoreRef.current = store
    cachedValueRef.current = newValue
    return newValue
  }, [store, selector, defaultValue])

  // 关键修复：当 store 为 null 时，订阅 sessionStoreManager 来监听 stores map 变化
  const subscribe = useCallback((onChange: () => void) => {
    if (!store) {
      // store 为 null 时，订阅 sessionStoreManager 监听 stores 或 activeSessionId 变化
      return sessionStoreManager.subscribe(onChange)
    }
    return store.subscribe(onChange)
  }, [store])

  // 服务端快照使用稳定的默认值
  const getServerSnapshot = useCallback(() => defaultValue, [defaultValue])

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/**
 * 订阅指定会话的特定状态
 *
 * 与 useActiveSessionSelector 类似，但支持指定 sessionId
 * 用于多窗口场景，需要同时显示多个会话的状态
 */
function useSessionSelector<T>(
  sessionId: string | null,
  selector: (state: ConversationState) => T,
  defaultValue: T
): T {
  const stores = useStore(sessionStoreManager, (state) => state.stores)

  // 使用 ref 缓存 store 实例，避免 stores Map 变化导致的重新订阅
  // 只有当 sessionId 变化或 store 真正不存在时才更新
  const cachedStoreRef = useRef<ConversationStoreInstance | null>(null)
  const cachedSessionIdRef = useRef<string | null>(null)

  const store = useMemo(() => {
    const targetStore = sessionId ? stores.get(sessionId) : null

    // sessionId 变化或 store 从 null 变为有效值时更新缓存
    if (
      cachedSessionIdRef.current !== sessionId ||
      (cachedStoreRef.current === null && targetStore !== null)
    ) {
      cachedStoreRef.current = targetStore ?? null
      cachedSessionIdRef.current = sessionId
    }

    return cachedStoreRef.current
  }, [stores, sessionId])

  // 缓存上次的值，确保引用稳定
  const cachedValueRef = useRef<T>(defaultValue)

  const getSnapshot = useCallback(() => {
    if (!store) {
      return defaultValue
    }
    const newValue = selector(store.getState())

    // 只有当值真正变化时才更新缓存（使用浅比较处理数组）
    const isEqual = Array.isArray(newValue) && Array.isArray(cachedValueRef.current)
      ? newValue === cachedValueRef.current || (
          newValue.length === (cachedValueRef.current as T[]).length &&
          newValue.every((item, i) => item === (cachedValueRef.current as T[])[i])
        )
      : newValue === cachedValueRef.current

    if (isEqual) {
      return cachedValueRef.current
    }

    cachedValueRef.current = newValue
    return newValue
  }, [store, selector, defaultValue])

  // 订阅逻辑：订阅正确的 store
  const subscribe = useCallback((onChange: () => void) => {
    if (!store) {
      // store 为 null 时，订阅 sessionStoreManager 监听 stores 变化
      return sessionStoreManager.subscribe(onChange)
    }
    return store.subscribe(onChange)
  }, [store])

  const getServerSnapshot = useCallback(() => defaultValue, [defaultValue])

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/**
 * 获取活跃会话的消息列表
 */
export function useActiveSessionMessages() {
  const messages = useActiveSessionSelector(
    useCallback((state: ConversationState) => state.messages, []),
    []
  )
  const archivedMessages = useActiveSessionSelector(
    useCallback((state: ConversationState) => state.archivedMessages, []),
    []
  )
  const currentMessage = useActiveSessionSelector(
    useCallback((state: ConversationState) => state.currentMessage, []),
    null
  )

  return useMemo(() => ({
    messages,
    archivedMessages,
    currentMessage,
  }), [messages, archivedMessages, currentMessage])
}

/**
 * 获取活跃会话的流式状态
 */
export function useActiveSessionStreaming() {
  return useActiveSessionSelector(
    useCallback((state: ConversationState) => state.isStreaming, []),
    false
  )
}

/**
 * 获取活跃会话的错误状态
 */
export function useActiveSessionError() {
  return useActiveSessionSelector(
    useCallback((state: ConversationState) => state.error, []),
    null
  )
}

/**
 * 获取活跃会话的会话 ID
 */
export function useActiveSessionConversationId() {
  return useActiveSessionSelector(
    useCallback((state: ConversationState) => state.conversationId, []),
    null
  )
}

/**
 * 获取活跃会话的输入草稿
 */
export function useActiveSessionInputDraft() {
  return useActiveSessionSelector(
    useCallback((state: ConversationState) => state.inputDraft, []),
    { text: '', attachments: [] }
  )
}

/**
 * 获取活跃会话的工作区
 */
export function useActiveSessionWorkspace() {
  const workspaceId = useActiveSessionSelector(
    useCallback((state: ConversationState) => state.workspaceId, []),
    null
  )

  // 使用 useWorkspaceStore 根据 workspaceId 查找工作区对象
  const workspace = useWorkspaceStore(
    useCallback((state) => {
      if (!workspaceId) return null
      return state.workspaces.find((w) => w.id === workspaceId) || null
    }, [workspaceId])
  )

  return workspace
}

/**
 * 获取活跃会话的 Block 映射
 */
export function useActiveSessionBlockMaps() {
  const toolBlockMap = useActiveSessionSelector(
    useCallback((state: ConversationState) => state.toolBlockMap, []),
    new Map()
  )
  const questionBlockMap = useActiveSessionSelector(
    useCallback((state: ConversationState) => state.questionBlockMap, []),
    new Map()
  )
  const planBlockMap = useActiveSessionSelector(
    useCallback((state: ConversationState) => state.planBlockMap, []),
    new Map()
  )
  const activePlanId = useActiveSessionSelector(
    useCallback((state: ConversationState) => state.activePlanId, []),
    null
  )

  return useMemo(() => ({
    toolBlockMap,
    questionBlockMap,
    planBlockMap,
    activePlanId,
  }), [toolBlockMap, questionBlockMap, planBlockMap, activePlanId])
}

/**
 * 获取活跃会话的操作方法
 * 
 * 返回稳定的方法引用，内部动态获取最新的 sessionId 和 store
 */
export function useActiveSessionActions() {
  // 使用 useMemo 确保返回的对象引用稳定
  return useMemo(() => {
    const actions = {
      sendMessage: async (...args: Parameters<ConversationStore['sendMessage']>) => {
        const sessionId = sessionStoreManager.getState().activeSessionId
        if (!sessionId) return
        const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
        if (!store) return
        return store.sendMessage(...args)
      },
      interrupt: async () => {
        const sessionId = sessionStoreManager.getState().activeSessionId
        if (!sessionId) return
        const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
        if (!store) return
        return store.interrupt()
      },
      continueChat: async (prompt?: string) => {
        const sessionId = sessionStoreManager.getState().activeSessionId
        if (!sessionId) return
        const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
        if (!store) return
        return store.continueChat(prompt)
      },
      deleteMessage: (messageId: string) => {
        const sessionId = sessionStoreManager.getState().activeSessionId
        if (!sessionId) return
        const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
        if (!store) return
        return store.deleteMessage(messageId)
      },
      editAndResend: async (messageId: string, newContent: string) => {
        const sessionId = sessionStoreManager.getState().activeSessionId
        if (!sessionId) return
        const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
        if (!store) return
        return store.editAndResend(messageId, newContent)
      },
      regenerateResponse: async (messageId: string) => {
        const sessionId = sessionStoreManager.getState().activeSessionId
        if (!sessionId) return
        const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
        if (!store) return
        return store.regenerateResponse(messageId)
      },
      // Input draft actions
      updateInputDraft: (draft: import('./types').InputDraft) => {
        const sessionId = sessionStoreManager.getState().activeSessionId
        if (!sessionId) return
        const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
        if (!store) return
        return store.updateInputDraft(draft)
      },
      clearInputDraft: () => {
        const sessionId = sessionStoreManager.getState().activeSessionId
        if (!sessionId) return
        const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
        if (!store) return
        return store.clearInputDraft()
      },
      clearMessages: () => {
        const sessionId = sessionStoreManager.getState().activeSessionId
        if (!sessionId) return
        const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
        if (!store) return
        return store.clearMessages()
      },
      loadMoreArchivedMessages: (count = 20) => {
        const sessionId = sessionStoreManager.getState().activeSessionId
        if (!sessionId) return
        const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
        if (!store) return
        return store.loadMoreArchivedMessages(count)
      },
      // Manager actions
      switchSession: sessionStoreManager.getState().switchSession,
      deleteSession: sessionStoreManager.getState().deleteSession,
      createSession: sessionStoreManager.getState().createSession,
    }
    return actions
  }, []) // 空依赖数组，对象引用永远不变
}

/**
 * 获取当前活跃会话的状态和操作方法
 *
 * 返回统一的活跃会话状态和操作接口
 */
export function useActiveSessionChat(): ConversationStore | null {
  const sessionId = useActiveSessionId()
  const stores = useStore(sessionStoreManager, (state) => state.stores)

  const store = sessionId ? stores.get(sessionId) : null

  return useMemo(() => {
    if (!store) return null
    return store.getState()
  }, [store])
}

/**
 * 完整的活跃会话 Hook（状态 + 操作）
 *
 * 用法：
 * ```tsx
 * const { messages, isStreaming, sendMessage, interrupt } = useActiveSession()
 * ```
 */
export function useActiveSession() {
  const messagesState = useActiveSessionMessages()
  const isStreaming = useActiveSessionStreaming()
  const error = useActiveSessionError()
  const conversationId = useActiveSessionConversationId()
  const blockMaps = useActiveSessionBlockMaps()
  const actions = useActiveSessionActions()

  return useMemo(() => ({
    // 消息状态
    ...messagesState,

    // 流式状态
    isStreaming,

    // 错误状态
    error,

    // 会话 ID
    conversationId,

    // Block 映射
    ...blockMaps,

    // 操作方法
    ...actions,
  }), [messagesState, isStreaming, error, conversationId, blockMaps, actions])
}

// ========================================
// 指定会话的 Hooks（用于多窗口场景）
// ========================================

/**
 * 获取指定会话的消息列表
 *
 * 用法：
 * ```tsx
 * const { messages, archivedMessages, currentMessage } = useSessionMessages(sessionId)
 * ```
 */
export function useSessionMessages(sessionId: string | null) {
  const messages = useSessionSelector(
    sessionId,
    useCallback((state: ConversationState) => state.messages, []),
    []
  )
  const archivedMessages = useSessionSelector(
    sessionId,
    useCallback((state: ConversationState) => state.archivedMessages, []),
    []
  )
  const currentMessage = useSessionSelector(
    sessionId,
    useCallback((state: ConversationState) => state.currentMessage, []),
    null
  )

  return useMemo(() => ({
    messages,
    archivedMessages,
    currentMessage,
  }), [messages, archivedMessages, currentMessage])
}

/**
 * 获取指定会话的流式状态
 */
export function useSessionStreaming(sessionId: string | null) {
  return useSessionSelector(
    sessionId,
    useCallback((state: ConversationState) => state.isStreaming, []),
    false
  )
}

/**
 * 获取指定会话的错误状态
 */
export function useSessionError(sessionId: string | null) {
  return useSessionSelector(
    sessionId,
    useCallback((state: ConversationState) => state.error, []),
    null
  )
}

/**
 * 获取指定会话的 block 映射
 */
function useSessionBlockMaps(sessionId: string | null) {
  const questionBlockMap = useSessionSelector(
    sessionId,
    useCallback((state: ConversationState) => state.questionBlockMap, []),
    new Map()
  )
  const toolBlockMap = useSessionSelector(
    sessionId,
    useCallback((state: ConversationState) => state.toolBlockMap, []),
    new Map()
  )
  return useMemo(() => ({ questionBlockMap, toolBlockMap }), [questionBlockMap, toolBlockMap])
}

/** 指定会话是否有待回答的问题（用于多窗口指示） */
export function useSessionHasPendingQuestion(sessionId: string | null): boolean {
  const { questionBlockMap, toolBlockMap } = useSessionBlockMaps(sessionId)
  const { currentMessage } = useSessionMessages(sessionId)
  return useMemo(() => {
    if (!currentMessage) return false
    // 检查 question block
    for (const blockIndex of questionBlockMap.values()) {
      const block = currentMessage.blocks[blockIndex]
      if (block?.type === 'question' && (block as ContentBlock & { status: string }).status === 'pending') return true
    }
    // 检查 AskUserQuestion tool_call block
    for (const blockIndex of toolBlockMap.values()) {
      const block = currentMessage.blocks[blockIndex]
      if (block?.type === 'tool_call' && (block as import('../../types/chat').ToolCallBlock).name === 'AskUserQuestion') {
        const toolBlock = block as import('../../types/chat').ToolCallBlock
        if (toolBlock.status !== 'failed' && Array.isArray(toolBlock.input?.questions)) return true
      }
    }
    return false
  }, [currentMessage, questionBlockMap, toolBlockMap])
}

// ========================================
// 派生状态 Hooks
// ========================================

/** 是否有待回答的问题 */
export function useHasPendingQuestion(): boolean {
  const pendingQuestions = usePendingQuestions()
  return useMemo(() => pendingQuestions.length > 0, [pendingQuestions])
}

/** 获取活跃会话中所有待回答的问题块 */
export function usePendingQuestions(): import('../../types').QuestionBlock[] {
  const { questionBlockMap, toolBlockMap } = useActiveSessionBlockMaps()
  const { currentMessage } = useActiveSessionMessages()
  return useMemo(() => {
    if (!currentMessage) return []
    const result: import('../../types').QuestionBlock[] = []

    // 1. 从 question 类型 block 中获取（后端发出了 question 事件）
    if (questionBlockMap.size) {
      for (const blockIndex of questionBlockMap.values()) {
        const block = currentMessage.blocks[blockIndex]
        if (block?.type === 'question' && (block as ContentBlock & { status: string }).status === 'pending') {
          result.push(block as import('../../types').QuestionBlock)
        }
      }
    }

    // 2. 从 AskUserQuestion tool_call block 中提取（后端只发出了 tool_call 事件）
    if (toolBlockMap.size) {
      for (const [toolId, blockIndex] of toolBlockMap) {
        const block = currentMessage.blocks[blockIndex]
        if (block?.type === 'tool_call' && (block as import('../../types/chat').ToolCallBlock).name === 'AskUserQuestion') {
          const toolBlock = block as import('../../types/chat').ToolCallBlock
          // 跳过已失败或尚未完成的工具调用
          if (toolBlock.status === 'failed') continue
          // 避免与已有的 question block 重复（同 ID）
          if (result.some(q => q.id === toolId)) continue

          const questions = toolBlock.input?.questions
          if (!Array.isArray(questions)) continue

          for (let i = 0; i < questions.length; i++) {
            const q = questions[i] as Record<string, unknown>
            const options = Array.isArray(q.options)
              ? q.options.map((o: Record<string, unknown>) => ({
                  value: (o.value as string) || (o.label as string) || '',
                  label: o.label as string | undefined,
                  description: o.description as string | undefined,
                  preview: o.preview as string | undefined,
                }))
              : []
            result.push({
              type: 'question',
              id: `${toolId}_q${i}`,
              header: (q.header as string) || (q.question as string) || '',
              multiSelect: q.multiSelect as boolean | undefined,
              options,
              allowCustomInput: q.allowCustomInput as boolean | undefined,
              status: 'pending',
            })
          }
        }
      }
    }

    return result
  }, [currentMessage, questionBlockMap, toolBlockMap])
}

/** 是否有活跃的计划（等待审批） */
export function useHasActivePlan(): boolean {
  const { planBlockMap, activePlanId } = useActiveSessionBlockMaps()
  const { currentMessage } = useActiveSessionMessages()
  return useMemo(() => {
    if (!activePlanId || !currentMessage) return false
    const planBlockIndex = planBlockMap.get(activePlanId)
    if (planBlockIndex === undefined) return false
    const block = currentMessage.blocks[planBlockIndex]
    if (block?.type === 'plan_mode') {
      const status = (block as ContentBlock & { status: string }).status
      return status === 'pending_approval' || status === 'drafting'
    }
    return false
  }, [planBlockMap, activePlanId, currentMessage])
}