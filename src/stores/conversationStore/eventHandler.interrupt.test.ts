/**
 * 中断 / 消息保留 回归测试
 *
 * 背景：commit ef3051e9 引入的 fallback 路径（error + session_end(reason=error)）
 * 在 user interrupt 场景下，前端 error handler 把 currentMessage 置 null，导致
 * 已输出的流式消息被丢弃、且错误地显示"异常退出"。
 *
 * 修复后：
 * - error handler 不再清空 currentMessage（消息固化由 session_end 的 finishMessage 负责）
 * - error handler 在 isInterrupting 时直接 break（静默）
 * - 新增 isInterrupting 标志，用户主动中断时 session_end 静默结束，不显示错误提示
 * - interrupt() 不提前设 isStreaming=false / 不调 finishMessage()，避免 UI 闪烁
 *
 * 测试覆盖：
 * 1. 用户主动中断（error+session_end 双事件）：静默、不显示错误、标志清除、消息固化。
 * 2. 意外崩溃（非中断）：仍显示兜底错误提示。
 * 3. error handler 不把 currentMessage 置 null，保留给 session_end 的 finishMessage 固化。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/services/dialogStorage', () => ({ dialogStorageService: {} }))
vi.mock('@/services/voiceNotificationService', () => ({
  voiceNotificationService: { notifyError: () => {} },
}))
vi.mock('./sessionStoreManager', () => ({ sessionStoreManager: {} }))
vi.mock('@/stores/workspaceStore', () => ({ useWorkspaceStore: { getState: () => ({}) } }))
vi.mock('@/stores/cliInfoStore', () => ({
  useCliInfoStore: { getState: () => ({ updateFromInit: () => {} }) },
}))
vi.mock('@/plugin-system/chatCardRegistry', () => ({ chatCardRegistry: { get: () => undefined } }))

import { handleAIEvent } from './eventHandler'
import type { ConversationStore } from './types'
import type { AIEvent } from '@/ai-runtime'

const currentMsg = {
  id: 'msg-1',
  type: 'assistant' as const,
  engineId: 'claude-code' as any,
  blocks: [{ type: 'text' as const, text: 'hello world' }],
  isStreaming: true,
  timestamp: '',
}

function makeStore(opts: { isInterrupting?: boolean; currentMessage?: typeof currentMsg; error?: string | null } = {}) {
  const state: Record<string, any> = {
    sessionId: 's1',
    error: opts.error ?? null,
    currentMessage: opts.currentMessage ?? null,
    isStreaming: true,
    isInterrupting: opts.isInterrupting ?? false,
    messages: [] as any[],
    finishMessage: () => {
      if (state.currentMessage) {
        const done = { ...state.currentMessage, isStreaming: false as const }
        state.messages = [...state.messages, done]
        state.currentMessage = null
      }
    },
    getPersistableMessages: () => [],
  }

  const set = (partial: Partial<ConversationStore>) => {
    Object.assign(state, partial)
  }
  const get = () => state as unknown as ConversationStore
  return { set, get, store: state as unknown as ConversationStore & { finishMessage: () => void; getPersistableMessages: () => unknown[] } }
}

describe('interrupt / message preservation', () => {
  it('用户主动中断：error+session_end 双事件 → 静默、不显示错误、标志清除、消息固化', () => {
    const { set, get, store } = makeStore({
      isInterrupting: true,
      currentMessage: currentMsg,
    })
    expect(get().isInterrupting).toBe(true)

    // 后端发 error（中断后硬杀触发 fallback）
    handleAIEvent(
      { type: 'error', sessionId: 's1', error: 'Claude CLI 异常退出' },
      set as never,
      get as never,
    )
    // isInterrupting 时 error handler 静默：不设 error、不清 currentMessage
    expect(get().error).toBeNull()
    expect(get().currentMessage).toBe(currentMsg)

    // 后端发 session_end(reason=error)
    handleAIEvent(
      { type: 'session_end', sessionId: 's1', reason: 'error' },
      set as never,
      get as never,
    )

    // 不显示错误提示（用户主动中断被排除）
    expect(get().error).toBeNull()
    // 标志被清除
    expect(get().isInterrupting).toBe(false)
    expect(get().isStreaming).toBe(false)
    // 消息已固化到 messages
    expect(store.messages.length).toBe(1)
    expect(store.messages[0].blocks[0].text).toBe('hello world')
  })

  it('意外崩溃（非中断）：仍显示兜底错误提示', () => {
    const { set, get } = makeStore({ isInterrupting: false })
    // 模拟 session_end(reason=error) 无前置 error 事件（error 丢失场景）
    handleAIEvent(
      { type: 'session_end', sessionId: 's1', reason: 'error' },
      set as never,
      get as never,
    )
    expect(get().error).toBe('errors:appError.ai')
    expect(get().isInterrupting).toBe(false)
  })

  it('error handler 不把 currentMessage 置 null，保留给 session_end 的 finishMessage 固化', () => {
    const { set, get, store } = makeStore({ currentMessage: currentMsg })

    // error 先到达（非中断路径）
    handleAIEvent(
      { type: 'error', sessionId: 's1', error: 'test error' },
      set as never,
      get as never,
    )

    // error handler 不应清空 currentMessage
    expect(get().currentMessage).toBe(currentMsg)
    expect(get().error).toBe('test error')

    // session_end 到达，finishMessage 应能拿到 currentMessage 并固化
    handleAIEvent(
      { type: 'session_end', sessionId: 's1', reason: 'completed' },
      set as never,
      get as never,
    )

    expect(store.messages.length).toBe(1)
    expect(store.messages[0].blocks[0].text).toBe('hello world')
    expect(get().currentMessage).toBeNull() // finishMessage 固化后才置空
  })
})