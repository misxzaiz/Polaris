/**
 * useActiveSession - 统一的活跃会话状态 Hook
 *
 * 封装 sessionStoreManager，提供与 useEventChatStore 兼容的接口
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
import type { ConversationStore, ConversationState } from './types'

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

  const subscribe = useCallback((onChange: () => void) => {
    if (!store) return () => {}
    return store.subscribe(onChange)
  }, [store])

  // 服务端快照使用稳定的默认值
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
 * 返回与 useEventChatStore 兼容的接口
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