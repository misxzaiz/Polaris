/**
 * session_end fallback 兜底回归测试
 *
 * 场景：后端 Claude 引擎在 CLI 异常退出（崩溃/被杀/输出畸形）时，
 * 未收到 SessionEnd 即 EOF。修复后后端会先发 error 事件（带 stderr 摘要），
 * 再发 session_end(reason=error)。
 *
 * 本测试覆盖前端 eventHandler 的两条路径：
 * 1. 正常路径：error 事件先到达，state.error 已填充原文 → session_end 不覆盖。
 * 2. 兜底路径：仅有 session_end(reason=error)，无前置 error 事件 →
 *    设兜底文案 errors:appError.ai，避免"静默中断无错误信息"。
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

function makeStore(error: string | null = null) {
  let state = {
    sessionId: 's1',
    error,
    currentMessage: null,
    messages: [],
    isStreaming: true,
  } as unknown as ConversationStore
  // eventHandler 调用 store 方法：finishMessage / getPersistableMessages 等。
  // 兜底路径只关心 set/get/error，mock 其余为 no-op。
  const store = state as unknown as ConversationStore & {
    finishMessage: () => void
    getPersistableMessages: () => unknown[]
  }
  store.finishMessage = () => {}
  store.getPersistableMessages = () => []
  const set = (partial: Partial<ConversationStore>) => {
    state = { ...state, ...partial }
    Object.assign(store, state)
  }
  const get = () => state
  return { set, get, store }
}

describe('session_end fallback', () => {
  it('error 事件先到达时，session_end 不覆盖已有错误', () => {
    const { set, get, store } = makeStore()
    const errorEvent: AIEvent = {
      type: 'error',
      sessionId: 's1',
      error: 'Claude CLI 异常退出:\nError: api key invalid',
    }
    handleAIEvent(errorEvent, set as never, get as never)
    // error 事件已设置原文
    expect(get().error).toBe('Claude CLI 异常退出:\nError: api key invalid')

    // 随后 session_end(reason=error) 到达，不应覆盖已有原文
    const endEvent: AIEvent = {
      type: 'session_end',
      sessionId: 's1',
      reason: 'error',
    }
    handleAIEvent(endEvent, set as never, get as never)
    expect(get().error).toBe('Claude CLI 异常退出:\nError: api key invalid')
    expect(get().isStreaming).toBe(false)
    // store 引用保持一致
    expect(store).toBeDefined()
  })

  it('仅有 session_end(reason=error) 无前置 error 时，设兜底文案', () => {
    const { set, get } = makeStore()
    const endEvent: AIEvent = {
      type: 'session_end',
      sessionId: 's1',
      reason: 'error',
    }
    handleAIEvent(endEvent, set as never, get as never)
    // 兜底：给出可见提示而非空
    expect(get().error).toBe('errors:appError.ai')
    expect(get().isStreaming).toBe(false)
  })

  it('session_end(reason=completed) 不设错误', () => {
    const { set, get } = makeStore()
    const endEvent: AIEvent = {
      type: 'session_end',
      sessionId: 's1',
      reason: 'completed',
    }
    handleAIEvent(endEvent, set as never, get as never)
    expect(get().error).toBeNull()
    expect(get().isStreaming).toBe(false)
  })

  it('session_end 无 reason 字段时不设错误', () => {
    const { set, get } = makeStore()
    const endEvent: AIEvent = {
      type: 'session_end',
      sessionId: 's1',
    }
    handleAIEvent(endEvent, set as never, get as never)
    expect(get().error).toBeNull()
  })
})
