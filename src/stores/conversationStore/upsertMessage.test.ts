/**
 * upsertMessage 单测 — S3 Phase 4 跨端实时合并（同 id 更新语义）
 *
 * 覆盖核心行为：
 * 1. 同 id 已存在 → 替换该消息（保位置，不重排）；
 * 2. 不存在 → 追加；
 * 3. 空 messages → 追加；
 * 4. 替换后流式增量可连续更新（同 id 多次替换 → 最终为最新 content）。
 *
 * upsertMessage 是纯 store 方法，不触发流式路径（避开 messageSync/transport 依赖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversationStore } from './createConversationStore'
import type { StoreDeps } from './types'
import type { ChatMessage } from '@/types'

// 屏蔽流式同步依赖：本测试不验证 appendTextBlock → syncStreamingMessage 链路
vi.mock('@/session-v2/messageSync', () => ({
  syncSessionToShared: vi.fn(async () => true),
  syncStreamingMessage: vi.fn(async () => {}),
}))

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

function userMsg(id: string, content: string): ChatMessage {
  return { id, type: 'user', content, timestamp: '2026-10-11T00:00:00.000Z' }
}

function assistantMsg(id: string, text: string): ChatMessage {
  return {
    id,
    type: 'assistant',
    blocks: [{ type: 'text', content: text }],
    timestamp: '2026-10-11T00:01:00.000Z',
  }
}

describe('upsertMessage', () => {
  let store: ReturnType<typeof createConversationStore>

  beforeEach(() => {
    store = createConversationStore('session-upsert-test', createDeps())
  })

  it('不存在 → 追加（首次到达）', () => {
    store.getState().addMessage(userMsg('u1', '你好'))
    store.getState().upsertMessage(assistantMsg('a1', '回复'))
    const msgs = store.getState().messages
    expect(msgs.length).toBe(2)
    expect(msgs[1].id).toBe('a1')
  })

  it('同 id 已存在 → 替换（保持原位置，不重排）', () => {
    store.getState().addMessage(userMsg('u1', '你好'))
    store.getState().addMessage(assistantMsg('a1', '第一段'))
    // 流式增量：同 id 新内容替换
    store.getState().upsertMessage(assistantMsg('a1', '第一段+第二段'))
    const msgs = store.getState().messages
    expect(msgs.length).toBe(2) // 不新增
    expect(msgs[0].id).toBe('u1') // 位置保持
    expect(msgs[1].id).toBe('a1')
    expect((msgs[1].blocks[0] as { content: string }).content).toBe('第一段+第二段')
  })

  it('连续多次替换 → 最终为最新内容（流式边打边更新）', () => {
    store.getState().upsertMessage(assistantMsg('a1', '第'))
    store.getState().upsertMessage(assistantMsg('a1', '第一'))
    store.getState().upsertMessage(assistantMsg('a1', '第一段'))
    const msgs = store.getState().messages
    expect(msgs.length).toBe(1)
    expect((msgs[0].blocks[0] as { content: string }).content).toBe('第一段')
  })

  it('空 messages → 追加', () => {
    store.getState().upsertMessage(userMsg('u1', '你好'))
    expect(store.getState().messages.length).toBe(1)
  })
})
