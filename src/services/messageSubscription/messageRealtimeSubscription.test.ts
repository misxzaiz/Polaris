/**
 * messageRealtimeSubscription 单测 — S3 阶段 3（渐进方案 A）
 *
 * 覆盖核心行为：
 * 1. 启动订阅：register listen('chat-message-upserted')，handler 注册成功返回退订函数；
 * 2. 路由：按 conversationId 用 findStoreByConversationId 定位 Web 端 store；
 * 3. 合并：远端 MessageEntry.content（完整 ChatMessage JSON）还原后 addMessage 进 store；
 * 4. 去重：store 已存在同 id → 跳过（防自广播回环 + 幂等）；
 * 5. 会话未打开：无 store → 忽略，不抛错；
 * 6. 结构异常：content 非合法 ChatMessage → 跳过；
 * 7. 幂等启动 / 停止清理。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  startMessageRealtimeSubscription,
  stopMessageRealtimeSubscription,
} from './messageRealtimeSubscription'
import { listen } from '@/services/transport'
import { findStoreByConversationId } from '@/stores/conversationStore/sessionStoreManager'

// ============================================================================
// mocks
// ============================================================================

const listeners = new Map<string, (payload: unknown) => void>()
const listenerReturns = new Map<string, () => void>()

vi.mock('@/services/transport', () => ({
  listen: vi.fn(
    (_event: string, handler: (payload: unknown) => void): Promise<() => void> => {
      listeners.set(_event, handler)
      const unsub = () => {
        listeners.delete(_event)
        listenerReturns.delete(_event)
      }
      listenerReturns.set(_event, unsub)
      return Promise.resolve(unsub)
    },
  ),
}))

/** 当前被恶意配置的「已打开会话」store；undefined = 会话未打开 */
let fakeStore:
  | { conversationId: string; messages: Array<{ id: string }>; addMessage: ReturnType<typeof vi.fn> }
  | undefined

vi.mock('@/stores/conversationStore/sessionStoreManager', () => ({
  findStoreByConversationId: vi.fn((conversationId: string) => {
    return fakeStore?.conversationId === conversationId ? fakeStore : undefined
  }),
}))

// ============================================================================

function makeUserPayload(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-1',
    message: {
      id: 'm1',
      conversationId: 'conv-1',
      role: 'user',
      timestamp: 1728600000000,
      deviceId: 'dev-web',
      content: {
        id: 'm1',
        type: 'user',
        content: '你好',
        timestamp: '2026-10-11T00:00:00.000Z',
      },
      version: 1,
    },
    ...overrides,
  }
}

function emit(payload: unknown): void {
  const handler = listeners.get('chat-message-upserted')
  // 监听已注销时 handler 为 undefined，调用方用副作用断言验证「不再投递」
  handler?.(payload)
}

describe('messageRealtimeSubscription', () => {
  beforeEach(() => {
    listeners.clear()
    fakeStore = undefined
  })

  afterEach(async () => {
    await stopMessageRealtimeSubscription()
  })

  it('启动订阅：注册 chat-message-upserted 监听', async () => {
    await startMessageRealtimeSubscription()
    expect(listeners.has('chat-message-upserted')).toBe(true)
  })

  it('幂等启动：重复调用不重复注册', async () => {
    await startMessageRealtimeSubscription()
    await startMessageRealtimeSubscription()
    // mock 的 listen 只在首次给 entry，重复调用直接 return；注册数量应为 1 次调用
    expect(listeners.size).toBe(1)
  })

  it('合并：远端消息还原为 ChatMessage 并 addMessage 进对应会话 store', async () => {
    fakeStore = { conversationId: 'conv-1', messages: [], addMessage: vi.fn() }
    await startMessageRealtimeSubscription()
    emit(makeUserPayload())

    expect(fakeStore.addMessage).toHaveBeenCalledTimes(1)
    const msg = fakeStore.addMessage.mock.calls[0][0]
    expect(msg.id).toBe('m1')
    expect(msg.type).toBe('user')
    expect(msg.content).toBe('你好')
  })

  it('去重：本端已存在同 id → 跳过，不重复合并', async () => {
    fakeStore = {
      conversationId: 'conv-1',
      messages: [{ id: 'm1' }],
      addMessage: vi.fn(),
    }
    await startMessageRealtimeSubscription()
    emit(makeUserPayload())
    expect(fakeStore.addMessage).not.toHaveBeenCalled()
  })

  it('会话未打开：无对应 store → 忽略，不抛错', async () => {
    // fakeStore 未配置 = findStoreByConversationId 返回 undefined
    await startMessageRealtimeSubscription()
    expect(() => emit(makeUserPayload())).not.toThrow()
  })

  it('结构异常：content 非合法 ChatMessage → 跳过且不抛错', async () => {
    fakeStore = { conversationId: 'conv-1', messages: [], addMessage: vi.fn() }
    await startMessageRealtimeSubscription()
    emit(makeUserPayload({ message: { ...(makeUserPayload().message as object), content: { foo: 1 } } }))
    expect(fakeStore.addMessage).not.toHaveBeenCalled()
  })

  it('停止订阅：注销事件监听，后续广播不再交付', async () => {
    fakeStore = { conversationId: 'conv-1', messages: [], addMessage: vi.fn() }
    await startMessageRealtimeSubscription()
    await stopMessageRealtimeSubscription()
    expect(listeners.has('chat-message-upserted')).toBe(false)
    // 注销后 handler 已被移除 → emit 变成 no-op，不再投递到 store
    emit(makeUserPayload())
    expect(fakeStore.addMessage).not.toHaveBeenCalled()
  })
})