/**
 * pendingQueue 派发与队列项管理测试
 *
 * 覆盖（plans/pending-queue-optimization-final.md 批次 1 验收标准）：
 * 1. 补丁 A：dispatchNextPending 失败 → 队首保留（不静默丢）+ 终止派发；成功 → 消费 + 继续下一条。
 * 2. 补丁 C：sendPendingNow 与 dispatchNextPending 互斥（queueDispatching 锁）。
 * 3. 增强 4：editPending 草稿冲突守卫 / 恢复草稿 / sending 锁定。
 */
import { describe, expect, it, vi } from 'vitest'
import { createConversationStore } from './createConversationStore'
import type { StoreDeps } from './types'
import type { AIEvent } from '../../ai-runtime'

vi.mock('@/services/dialogStorage', () => ({ dialogStorageService: {} }))
vi.mock('@/services/voiceNotificationService', () => ({
  voiceNotificationService: { notifyError: () => {} },
}))
vi.mock('./sessionStoreManager', () => ({ sessionStoreManager: {} }))
vi.mock('@/stores/workspaceStore', () => ({ useWorkspaceStore: { getState: () => ({}) } }))
vi.mock('@/stores/cliInfoStore', () => ({
  useCliInfoStore: { getState: () => ({ updateFromInit: () => {} }) },
}))
vi.mock('@/plugin-system/chatCardRegistry', () => ({
  chatCardRegistry: {
    register: () => {},
    registerBuiltin: () => {},
    // builtinPlugins.ts 会调 registerBuiltinExact 注册 'ui.render'（ui-template-runtime-v1），
    // mock 需提供该方法，否则模块初始化即抛 TypeError
    registerBuiltinExact: () => {},
    unregisterAll: () => {},
    match: () => undefined,
    get: () => undefined,
    resolve: () => undefined,
  },
}))
vi.mock('@/services/aiChatDispatch', () => ({
  aiChatDispatch: vi.fn(),
  aiChatDispatchStream: vi.fn(),
}))
vi.mock('@/services/eventBus', () => ({ eventBus: { emit: vi.fn() } }))
vi.mock('../toastStore', () => ({
  useToastStore: { getState: () => ({ error: vi.fn() }) },
}))

import type { AIEvent } from '../../ai-runtime'

function createDeps(): StoreDeps {
  return {
    getConfig: () => ({ defaultEngine: 'custom-engine' }),
    getWorkspace: () => null,
    getContextWorkspaceIds: () => [],
    getAllWorkspaces: () => [],
    getEventRouter: () => ({}) as StoreDeps['getEventRouter'] extends () => infer T ? T : never,
    contextId: 'test-context',
  }
}

/** 完成一轮流式：session_start → token → session_end，使 isStreaming=false */
function completeStreamingTurn(store: ReturnType<typeof createConversationStore>) {
  store.getState().handleAIEvent({
    type: 'session_start',
    sessionId: 'session-1',
    conversationId: 'conv-1',
  } as AIEvent)
  store.getState().handleAIEvent({
    type: 'session_end',
    sessionId: 'session-1',
    conversationId: 'conv-1',
    reason: 'completed',
  } as AIEvent)
}

describe('pendingQueue dispatch (补丁 A: 失败保留 + 停止空转)', () => {
  it('sendMessage 失败 → 队首放回、终止派发、不丢消息', async () => {
    const store = createConversationStore('session-1', createDeps())
    store.getState().enqueuePending({
      id: 'q1',
      text: '第一条',
      createdAt: 1,
    })
    store.getState().enqueuePending({
      id: 'q2',
      text: '第二条',
      createdAt: 2,
    })
    // 模拟 sendMessage 失败：返回 false
    const sendSpy = vi.spyOn(store.getState(), 'sendMessage').mockResolvedValue(false)

    await store.getState().dispatchNextPending()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    // 队首放回 + 第二条仍在 → 队列保留两条（顺序 q1 在队首）
    const queue = store.getState().pendingQueue
    expect(queue.map((m) => m.id)).toEqual(['q1', 'q2'])
    // 失败后终止派发：isStreaming 不再变、锁已释放
    expect(store.getState().queueDispatching).toBe(false)
  })

  it('sendMessage 成功 → 队首消费、自动派发下一条', async () => {
    const store = createConversationStore('session-1', createDeps())
    store.getState().enqueuePending({
      id: 'q1',
      text: '第一条',
      createdAt: 1,
    })
    store.getState().enqueuePending({
      id: 'q2',
      text: '第二条',
      createdAt: 2,
    })
    // 模拟 sendMessage 成功：true，且每轮后置 isStreaming=false（模拟一轮流式完成）
    const sendSpy = vi
      .spyOn(store.getState(), 'sendMessage')
      .mockImplementation(async () => {
        completeStreamingTurn(store)
        return true
      })

    await store.getState().dispatchNextPending()

    // 两条都被消费（自动逐条派发）
    expect(sendSpy).toHaveBeenCalledTimes(2)
    expect(store.getState().pendingQueue).toHaveLength(0)
    expect(store.getState().queueDispatching).toBe(false)
  })
})

describe('pendingQueue dispatch (补丁 C: 互斥锁)', () => {
  it('sendPendingNow 与 dispatchNextPending 并发 → 只有一条进入发送路径', async () => {
    const store = createConversationStore('session-1', createDeps())
    store.getState().enqueuePending({
      id: 'q1',
      text: '排队消息',
      createdAt: 1,
    })
    // sendMessage 成功
    vi.spyOn(store.getState(), 'sendMessage').mockImplementation(async () => {
      completeStreamingTurn(store)
      return true
    })
    // 同时触发两个入口
    await Promise.all([
      store.getState().dispatchNextPending(),
      store.getState().sendPendingNow('q1'),
    ])
    // q1 只被消费一次（不会双发）
    expect(store.getState().pendingQueue).toHaveLength(0)
  })
})

describe('editPending (增强 4: 撤回编辑)', () => {
  it('输入框为空 → 队列项移除 + 原文恢复草稿', () => {
    const store = createConversationStore('session-1', createDeps())
    store.getState().enqueuePending({
      id: 'q1',
      text: '待编辑消息',
      createdAt: 1,
    })
    store.getState().editPending('q1')
    expect(store.getState().pendingQueue).toHaveLength(0)
    expect(store.getState().inputDraft.text).toBe('待编辑消息')
  })

  it('输入框非空 → 冲突守卫拒绝、队列不变', () => {
    const store = createConversationStore('session-1', createDeps())
    store.getState().enqueuePending({
      id: 'q1',
      text: '待编辑消息',
      createdAt: 1,
    })
    store.getState().updateInputDraft({
      text: '用户正在写的内容',
      attachments: [],
      contextBlocks: [],
    })
    store.getState().editPending('q1')
    // 队列保持不变、草稿未被覆盖
    expect(store.getState().pendingQueue).toHaveLength(1)
    expect(store.getState().inputDraft.text).toBe('用户正在写的内容')
  })

  it('sending 中的条目不可撤回', () => {
    const store = createConversationStore('session-1', createDeps())
    store.getState().enqueuePending({
      id: 'q1',
      text: '正在发送',
      createdAt: 1,
      status: 'sending',
    })
    store.getState().editPending('q1')
    expect(store.getState().pendingQueue).toHaveLength(1)
  })
})
