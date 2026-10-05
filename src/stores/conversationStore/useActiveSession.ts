/**
 * useActiveSession - 统一的活跃会话状态 Hook
 *
 * 核心：useSessionState(sessionId, selector, fallback)
 *   — 单一订阅实现，替代原 useActiveSessionSelector + useSessionSelector 两套平行实现
 *   — 阶段 1 路由简化后 store 不会无中生有，订阅无需 cachedValueRef/cachedStoreRef 防 snapshot 抖动
 *
 * 各命名 hook 为 useSessionState 的薄包装，保持对外签名不变。
 */

import { useMemo, useCallback, useSyncExternalStore } from 'react'
import { useStore } from 'zustand'
import {
  sessionStoreManager,
  useActiveSessionId,
} from './sessionStoreManager'
import { useKernelSessionState } from '@/session-v2/hooks/useKernelSessionState'
import { getKernel } from '@/session-v2/kernel/registry'
import { useWorkspaceStore } from '../workspaceStore'
import type { ConversationStore, ConversationState, InputDraft, PromptOptimizeState } from './types'
import type { ContentBlock } from '@/types'
import type { ChatMessage } from '@/types/chat'

// ============================================================================
// 模块级稳定空值常量（getSnapshot 在 store 缺失时返回，保证引用稳定）
// ============================================================================
const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_INPUT_DRAFT: InputDraft = { text: '', attachments: [] }
const EMPTY_PENDING_QUEUE: import('../../types/chat').PendingMessage[] = []
const EMPTY_BLOCK_MAP: Map<string, number> = new Map()
const EMPTY_PROMPT_OPTIMIZE: PromptOptimizeState = {
  status: 'idle',
  history: [],
  cursor: -1,
  sourceSnapshot: null,
  pendingResult: null,
  pendingMeta: null,
  optimizeSessionId: null,
  error: null,
}

// ============================================================================
// 核心订阅实现
// ============================================================================

/**
 * 订阅指定会话的特定状态切片。
 *
 * @param sessionId 目标会话 ID（null 时返回 fallback）
 * @param selector  状态选择器
 * @param fallback  store 不存在时的回退值（必须引用稳定）
 */
export function useSessionState<T>(
  sessionId: string | null,
  selector: (state: ConversationState) => T,
  fallback: T,
): T {
  // 订阅 stores Map，使 sessionId 对应的 store 创建/删除时触发重渲染
  const stores = useStore(sessionStoreManager, (state) => state.stores)
  const store = sessionId ? stores.get(sessionId) ?? null : null

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!store) return sessionStoreManager.subscribe(onChange)
      return store.subscribe(onChange)
    },
    [store],
  )

  const getSnapshot = useCallback(() => {
    if (!store) return fallback
    return selector(store.getState())
  }, [store, selector, fallback])

  const getServerSnapshot = useCallback(() => fallback, [fallback])

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** 订阅活跃会话的状态切片 */
function useActiveSessionSelector<T>(
  selector: (state: ConversationState) => T,
  fallback: T,
): T {
  const sessionId = useActiveSessionId()
  return useSessionState(sessionId, selector, fallback)
}

// ============================================================================
// 活跃会话状态 hooks
// ============================================================================

export function useActiveSessionMessages() {
  const messages = useActiveSessionSelector(
    useCallback((s: ConversationState) => s.messages, []),
    EMPTY_MESSAGES,
  )
  const archivedMessages = useActiveSessionSelector(
    useCallback((s: ConversationState) => s.archivedMessages, []),
    EMPTY_MESSAGES,
  )
  const currentMessage = useActiveSessionSelector(
    useCallback((s: ConversationState) => s.currentMessage, []),
    null,
  )
  return useMemo(
    () => ({ messages, archivedMessages, currentMessage }),
    [messages, archivedMessages, currentMessage],
  )
}

/** 本地流式投影（store.isStreaming，token 级实时渲染用） */
export function useActiveSessionStreaming() {
  return useActiveSessionSelector(
    useCallback((s: ConversationState) => s.isStreaming, []),
    false,
  )
}

/** 后端权威流式状态（跨设备/重启场景用） */
export function useActiveSessionKernelStreaming() {
  const sessionId = useActiveSessionId()
  const { isStreaming } = useKernelSessionState(sessionId)
  return isStreaming
}

export function useActiveSessionError() {
  return useActiveSessionSelector(
    useCallback((s: ConversationState) => s.error, []),
    null,
  )
}

export function useActiveSessionConversationId() {
  return useActiveSessionSelector(
    useCallback((s: ConversationState) => s.conversationId, []),
    null,
  )
}

export function useActiveSessionInputDraft() {
  return useActiveSessionSelector(
    useCallback((s: ConversationState) => s.inputDraft, []),
    EMPTY_INPUT_DRAFT,
  )
}

export function useActiveSessionPendingBriefing() {
  return useActiveSessionSelector(
    useCallback((s: ConversationState) => s.pendingBriefing, []),
    null,
  )
}

export function useActiveSessionPendingQueue() {
  return useActiveSessionSelector(
    useCallback((s: ConversationState) => s.pendingQueue, []),
    EMPTY_PENDING_QUEUE,
  )
}

export function useActiveSessionPromptSuggestion() {
  return useActiveSessionSelector(
    useCallback((s: ConversationState) => s.promptSuggestion, []),
    null,
  )
}

export function useActiveSessionUsage() {
  return useActiveSessionSelector(
    useCallback((s: ConversationState) => s.usageStats, []),
    null,
  )
}

export function useActiveSessionPromptOptimize() {
  return useActiveSessionSelector(
    useCallback((s: ConversationState) => s.promptOptimize, []),
    EMPTY_PROMPT_OPTIMIZE,
  )
}

export function useActiveSessionWorkspace() {
  const workspaceId = useActiveSessionSelector(
    useCallback((s: ConversationState) => s.workspaceId, []),
    null,
  )
  return useWorkspaceStore(
    useCallback((state) => {
      if (!workspaceId) return null
      return state.workspaces.find((w) => w.id === workspaceId) ?? null
    }, [workspaceId]),
  )
}

export function useActiveSessionBlockMaps() {
  const toolBlockMap = useActiveSessionSelector(
    useCallback((s: ConversationState) => s.toolBlockMap, []),
    EMPTY_BLOCK_MAP,
  )
  const questionBlockMap = useActiveSessionSelector(
    useCallback((s: ConversationState) => s.questionBlockMap, []),
    EMPTY_BLOCK_MAP,
  )
  const planBlockMap = useActiveSessionSelector(
    useCallback((s: ConversationState) => s.planBlockMap, []),
    EMPTY_BLOCK_MAP,
  )
  const activePlanId = useActiveSessionSelector(
    useCallback((s: ConversationState) => s.activePlanId, []),
    null,
  )
  return useMemo(
    () => ({ toolBlockMap, questionBlockMap, planBlockMap, activePlanId }),
    [toolBlockMap, questionBlockMap, planBlockMap, activePlanId],
  )
}

// ============================================================================
// 活跃会话操作 hook
// ============================================================================

/**
 * 获取活跃会话的操作方法。
 * 返回稳定引用；每个 action 运行时动态解析 activeSessionId 与 store。
 */
export function useActiveSessionActions() {
  return useMemo(() => {
    const getStore = () => {
      const sid = sessionStoreManager.getState().activeSessionId
      if (!sid) return null
      return sessionStoreManager.getState().stores.get(sid)?.getState() ?? null
    }

    /** 委托给当前活跃 store 的同步方法 */
    const call = (method: string, ...args: unknown[]) => {
      const store = getStore()
      if (!store) return
      const fn = (store as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
      if (typeof fn === 'function') return fn(...args)
    }

    return {
      sendMessage: async (...args: Parameters<ConversationStore['sendMessage']>) => {
        const sid = sessionStoreManager.getState().activeSessionId
        if (!sid) return
        const kernel = await getKernel()
        await kernel.sendMessage({
          sessionId: sid,
          content: args[0],
          workspaceDir: args[1],
          attachments: args[2],
          sendOptions: args[3],
        })
      },
      interrupt: async () => {
        const sid = sessionStoreManager.getState().activeSessionId
        if (!sid) return
        const kernel = await getKernel()
        await kernel.interrupt(sid)
      },
      continueChat: async (prompt?: string, allowedTools?: string[]) => {
        const sid = sessionStoreManager.getState().activeSessionId
        if (!sid) return
        const kernel = await getKernel()
        await kernel.continueChat(sid, prompt ?? '', { allowedTools })
      },
      editAndResend: async (messageId: string, newContent: string) => {
        const sid = sessionStoreManager.getState().activeSessionId
        if (!sid) return
        const kernel = await getKernel()
        await kernel.editAndResend(sid, messageId, newContent)
      },
      regenerateResponse: async (messageId: string) => {
        const sid = sessionStoreManager.getState().activeSessionId
        if (!sid) return
        const kernel = await getKernel()
        await kernel.regenerate(sid, messageId)
      },

      // 同步方法统一委托
      deleteMessage: (id: string) => call('deleteMessage', id),
      updateInputDraft: (d: InputDraft) => call('updateInputDraft', d),
      clearInputDraft: () => call('clearInputDraft'),
      addContextBlock: (b: import('./types').ContextBlock) => call('addContextBlock', b),
      removeContextBlock: (id: string) => call('removeContextBlock', id),
      clearContextBlocks: () => call('clearContextBlocks'),
      updateContextBlockNote: (id: string, note: string) => call('updateContextBlockNote', id, note),
      setPendingBriefing: (b: string | null) => call('setPendingBriefing', b),
      enqueuePending: (m: import('../../types/chat').PendingMessage) => call('enqueuePending', m),
      removePending: (id: string) => call('removePending', id),
      clearPendingQueue: () => call('clearPendingQueue'),
      dispatchNextPending: async () => call('dispatchNextPending'),
      sendPendingNow: async (id: string) => call('sendPendingNow', id),
      setPromptSuggestion: (s: string | null) => call('setPromptSuggestion', s),
      undoPromptOptimize: () => call('undoPromptOptimize'),
      redoPromptOptimize: () => call('redoPromptOptimize'),
      applyPendingPromptOptimize: () => call('applyPendingPromptOptimize'),
      resetPromptOptimize: () => call('resetPromptOptimize'),
      clearPromptOptimizeError: () => call('failPromptOptimize', null),
      clearError: () => call('setError', null),
      clearMessages: () => call('clearMessages'),
      loadMoreArchivedMessages: (count = 20) => call('loadMoreArchivedMessages', count),
      onVisibleRangeChange: (start: number, end: number) => call('onVisibleRangeChange', start, end),

      // Manager actions
      switchSession: sessionStoreManager.getState().switchSession,
      deleteSession: sessionStoreManager.getState().deleteSession,
      createSession: sessionStoreManager.getState().createSession,
    }
  }, []) // 引用永远稳定
}

// ============================================================================
// 复合 hook
// ============================================================================

export function useActiveSessionChat(): ConversationStore | null {
  const sessionId = useActiveSessionId()
  const stores = useStore(sessionStoreManager, (s) => s.stores)
  const store = sessionId ? stores.get(sessionId) ?? null : null
  return useMemo(() => (store ? store.getState() : null), [store])
}

export function useActiveSession() {
  const messagesState = useActiveSessionMessages()
  const isStreaming = useActiveSessionStreaming()
  const error = useActiveSessionError()
  const conversationId = useActiveSessionConversationId()
  const blockMaps = useActiveSessionBlockMaps()
  const actions = useActiveSessionActions()
  return useMemo(
    () => ({
      ...messagesState,
      isStreaming,
      error,
      conversationId,
      ...blockMaps,
      ...actions,
    }),
    [messagesState, isStreaming, error, conversationId, blockMaps, actions],
  )
}

// ============================================================================
// 指定会话的 hooks（多窗口场景）
// ============================================================================

export function useSessionMessages(sessionId: string | null) {
  const messages = useSessionState(
    sessionId,
    useCallback((s: ConversationState) => s.messages, []),
    EMPTY_MESSAGES,
  )
  const archivedMessages = useSessionState(
    sessionId,
    useCallback((s: ConversationState) => s.archivedMessages, []),
    EMPTY_MESSAGES,
  )
  const currentMessage = useSessionState(
    sessionId,
    useCallback((s: ConversationState) => s.currentMessage, []),
    null,
  )
  return useMemo(
    () => ({ messages, archivedMessages, currentMessage }),
    [messages, archivedMessages, currentMessage],
  )
}

export function useSessionStreaming(sessionId: string | null) {
  return useSessionState(
    sessionId,
    useCallback((s: ConversationState) => s.isStreaming, []),
    false,
  )
}

export function useSessionError(sessionId: string | null) {
  return useSessionState(
    sessionId,
    useCallback((s: ConversationState) => s.error, []),
    null,
  )
}

/** 历史分页游标（尾部优先恢复） */
export function useSessionHistoryPaging(sessionId: string | null) {
  return useSessionState(
    sessionId,
    useCallback((s: ConversationState) => s.historyPaging, []),
    null,
  )
}

/** 可见区域锚点（滚动位置恢复用） */
export function useSessionVisibleRange(sessionId: string | null) {
  return useSessionState(
    sessionId,
    useCallback((s: ConversationState) => s.visibleRange, []),
    null,
  )
}

// ============================================================================
// 派生状态 hooks
// ============================================================================

function extractQuestionsFromBlocks(
  blocks: import('../../types').ContentBlock[],
): import('../../types').QuestionBlock[] {
  const result: import('../../types').QuestionBlock[] = []
  for (const block of blocks) {
    if (block.type === 'question' && (block as import('../../types').QuestionBlock).status === 'pending') {
      result.push(block as import('../../types').QuestionBlock)
    }
  }
  return result
}

export function useSessionHasPendingQuestion(sessionId: string | null): boolean {
  const { currentMessage, messages } = useSessionMessages(sessionId)
  return useMemo(() => {
    if (currentMessage) {
      const found = extractQuestionsFromBlocks(currentMessage.blocks)
      if (found.length > 0) return true
    }
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1]
      if (lastMsg.type === 'assistant' && 'blocks' in lastMsg) {
        return extractQuestionsFromBlocks(
          (lastMsg as import('../../types/chat').AssistantChatMessage).blocks,
        ).length > 0
      }
    }
    return false
  }, [currentMessage, messages])
}

export function usePendingQuestions(): import('../../types').QuestionBlock[] {
  const { currentMessage, messages } = useActiveSessionMessages()
  return useMemo(() => {
    if (currentMessage) {
      const result = extractQuestionsFromBlocks(currentMessage.blocks)
      if (result.length > 0) return result
    }
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1]
      if (lastMsg.type === 'assistant' && 'blocks' in lastMsg) {
        return extractQuestionsFromBlocks(
          (lastMsg as import('../../types/chat').AssistantChatMessage).blocks,
        )
      }
    }
    return []
  }, [currentMessage, messages])
}

export function useHasPendingQuestion(): boolean {
  const pendingQuestions = usePendingQuestions()
  return useMemo(() => pendingQuestions.length > 0, [pendingQuestions])
}

export function useHasActivePlan(): boolean {
  const { planBlockMap, activePlanId } = useActiveSessionBlockMaps()
  const { currentMessage } = useActiveSessionMessages()
  return useMemo(() => {
    if (!activePlanId || !currentMessage) return false
    const idx = planBlockMap.get(activePlanId)
    if (idx === undefined) return false
    const block = currentMessage.blocks[idx]
    if (block?.type === 'plan_mode') {
      const status = (block as ContentBlock & { status: string }).status
      return status === 'pending_approval' || status === 'drafting'
    }
    return false
  }, [planBlockMap, activePlanId, currentMessage])
}
