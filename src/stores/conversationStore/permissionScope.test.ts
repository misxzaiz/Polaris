/**
 * 权限路径单元测试（P1 session 范围放行 + 既有逐项决策/失效逻辑）
 *
 * 覆盖：
 * - addSessionAllowedTools：去重、空入参 no-op、无新增不触发 set
 * - sessionAllowedTools 初始为空、clearMessages 不重置（绑定会话而非消息）
 * - continueChat 将 sessionAllowedTools 并入 invoke 的 options.allowedTools（与显式 allowedTools 去重合并）
 * - resolvePermissionRequest：逐项落库 + 整卡状态推导（任一批准→approved）
 * - expireStalePermissionRequests：失效真实 denials、跳过 plan 空 denials 块
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock invoke（封装层），捕获 continue_chat 的入参以断言 allowedTools 合并结果
const mockInvoke = vi.fn(async () => undefined)
vi.mock('@/services/tauri', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { createConversationStore } from './createConversationStore'
import type { StoreDeps } from './types'
import type { ContentBlock } from '@/types'

type PermissionBlock = Extract<ContentBlock, { type: 'permission_request' }>

function createDeps(): StoreDeps {
  return {
    getConfig: () => ({ defaultEngine: 'claude-code' }),
    getWorkspace: () => null,
    getContextWorkspaceIds: () => [],
    getAllWorkspaces: () => [],
    // continueChat 会调用 router.initialize()
    getEventRouter: () => ({ initialize: async () => undefined }) as unknown as StoreDeps['getEventRouter'] extends () => infer T ? T : never,
    contextId: 'test-context',
  }
}

/** 读取注入到 currentMessage 的首个权限块 */
function firstPermissionBlock(store: ReturnType<typeof createConversationStore>): PermissionBlock {
  return store.getState().currentMessage?.blocks?.[0] as PermissionBlock
}

beforeEach(() => {
  mockInvoke.mockClear()
})

describe('sessionAllowedTools / addSessionAllowedTools', () => {
  it('初始 sessionAllowedTools 为空数组', () => {
    const store = createConversationStore('s-init', createDeps())
    expect(store.getState().sessionAllowedTools).toEqual([])
  })

  it('追加并去重（同名工具不重复累积）', () => {
    const store = createConversationStore('s-add', createDeps())
    store.getState().addSessionAllowedTools(['Bash', 'Write'])
    store.getState().addSessionAllowedTools(['Write', 'Read'])
    expect(store.getState().sessionAllowedTools.sort()).toEqual(['Bash', 'Read', 'Write'])
  })

  it('空入参为 no-op，不改变集合引用', () => {
    const store = createConversationStore('s-empty', createDeps())
    store.getState().addSessionAllowedTools(['Bash'])
    const before = store.getState().sessionAllowedTools
    store.getState().addSessionAllowedTools([])
    expect(store.getState().sessionAllowedTools).toBe(before) // 同一引用，未触发 set
  })

  it('无新增（全部已存在）时不触发 set，保持同一引用', () => {
    const store = createConversationStore('s-noop', createDeps())
    store.getState().addSessionAllowedTools(['Bash'])
    const before = store.getState().sessionAllowedTools
    store.getState().addSessionAllowedTools(['Bash'])
    expect(store.getState().sessionAllowedTools).toBe(before)
  })

  it('clearMessages 不重置 sessionAllowedTools（授权绑定会话生命周期，非消息）', () => {
    const store = createConversationStore('s-clear', createDeps())
    store.getState().addSessionAllowedTools(['Bash', 'Write'])
    store.getState().clearMessages()
    expect(store.getState().sessionAllowedTools.sort()).toEqual(['Bash', 'Write'])
    // 同时确认消息确实被清空
    expect(store.getState().messages).toEqual([])
  })
})

describe('continueChat 并入 sessionAllowedTools', () => {
  it('将会话集合并入 options.allowedTools（与显式入参去重合并）', async () => {
    const store = createConversationStore('s-cc', createDeps())
    store.getState().setConversationId('conv-1')
    store.getState().addSessionAllowedTools(['Bash', 'Read'])

    await store.getState().continueChat('[已授权] Write', ['Write', 'Bash'])

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    const [cmd, payload] = mockInvoke.mock.calls[0] as [string, { options: { allowedTools?: string[] } }]
    expect(cmd).toBe('continue_chat')
    expect([...(payload.options.allowedTools ?? [])].sort()).toEqual(['Bash', 'Read', 'Write'])
  })

  it('无显式 allowedTools 时仍携带会话集合（普通续聊持续放行）', async () => {
    const store = createConversationStore('s-cc2', createDeps())
    store.getState().setConversationId('conv-1')
    store.getState().addSessionAllowedTools(['Bash'])

    await store.getState().continueChat('继续')

    const [, payload] = mockInvoke.mock.calls[0] as [string, { options: { allowedTools?: string[] } }]
    expect(payload.options.allowedTools).toEqual(['Bash'])
  })

  it('会话集合为空且无显式入参时 allowedTools 为 undefined', async () => {
    const store = createConversationStore('s-cc3', createDeps())
    store.getState().setConversationId('conv-1')

    await store.getState().continueChat('继续')

    const [, payload] = mockInvoke.mock.calls[0] as [string, { options: { allowedTools?: string[] } }]
    expect(payload.options.allowedTools).toBeUndefined()
  })
})

describe('resolvePermissionRequest 逐项落库 + 整卡状态推导', () => {
  it('任一项批准 → 整卡 approved，逐项 status/scope 落库', () => {
    const store = createConversationStore('s-resolve', createDeps())
    store.getState().appendPermissionRequestBlock('req-1', 'conv-1', [
      { toolName: 'Bash', reason: '权限被拒绝' },
      { toolName: 'Write', reason: '权限被拒绝' },
    ])

    store.getState().resolvePermissionRequest('req-1', [
      { status: 'approved', scope: 'session' },
      { status: 'denied' },
    ])

    const block = firstPermissionBlock(store)
    expect(block.status).toBe('approved')
    expect(block.denials[0]).toMatchObject({ status: 'approved', scope: 'session' })
    expect(block.denials[1]).toMatchObject({ status: 'denied' })
  })

  it('全部拒绝 → 整卡 denied', () => {
    const store = createConversationStore('s-resolve2', createDeps())
    store.getState().appendPermissionRequestBlock('req-2', 'conv-1', [
      { toolName: 'Bash', reason: 'r' },
    ])

    store.getState().resolvePermissionRequest('req-2', [{ status: 'denied' }])

    expect(firstPermissionBlock(store).status).toBe('denied')
  })
})

describe('expireStalePermissionRequests', () => {
  it('失效有真实 denials 的 pending 块', () => {
    const store = createConversationStore('s-expire', createDeps())
    store.getState().appendPermissionRequestBlock('req-3', 'conv-1', [
      { toolName: 'Bash', reason: 'r' },
    ])

    store.getState().expireStalePermissionRequests()

    expect(firstPermissionBlock(store).status).toBe('expired')
  })

  it('跳过 plan 审批复用的空 denials 块（保持 pending）', () => {
    const store = createConversationStore('s-expire2', createDeps())
    store.getState().appendPermissionRequestBlock('req-4', 'conv-1', [])

    store.getState().expireStalePermissionRequests()

    expect(firstPermissionBlock(store).status).toBe('pending')
  })
})
