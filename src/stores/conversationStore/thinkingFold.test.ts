/**
 * 思考块自动折叠测试
 *
 * 锁定「思考完成即折叠」行为：思考流结束后出现正文 / 工具块 / 新思考块，
 * 或整条消息归档（finishMessage）时，此前的 thinking 块应被标记 collapsed: true。
 *
 * 渲染层（ThinkingBlockRenderer）响应 collapsed 自动收起，详见其 useEffect。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversationStore } from './createConversationStore'
import type { StoreDeps } from './types'
import type { ThinkingBlock } from '@/types'

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

function thinkingBlocks(store: ReturnType<typeof createConversationStore>): ThinkingBlock[] {
  const blocks = store.getState().currentMessage?.blocks ?? []
  return blocks.filter((b): b is ThinkingBlock => b.type === 'thinking')
}

describe('thinking block auto-collapse', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createStreamingStore() {
    const store = createConversationStore('session-fold-test', createDeps())
    store.setState({ isStreaming: true })
    return store
  }

  it('keeps thinking expanded while still streaming its content', () => {
    const store = createStreamingStore()

    store.getState().appendThinkingBlock('让我想想')
    store.getState().appendThinkingBlock('更深入分析')

    const blocks = thinkingBlocks(store)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toBe('让我想想更深入分析')
    // 思考流进行中：未折叠
    expect(blocks[0].collapsed).toBeUndefined()
  })

  it('folds thinking blocks when the body text starts', () => {
    const store = createStreamingStore()

    store.getState().appendThinkingBlock('第一步思考')
    expect(thinkingBlocks(store)[0].collapsed).toBeUndefined()

    // 正文开始出现（段落级缓冲：首 token 立即 flush）
    store.getState().appendTextBlock('这是回答')

    expect(thinkingBlocks(store)[0].collapsed).toBe(true)
  })

  it('folds thinking blocks when a tool call starts', () => {
    const store = createStreamingStore()

    store.getState().appendThinkingBlock('需要调用工具')
    expect(thinkingBlocks(store)[0].collapsed).toBeUndefined()

    store.getState().appendToolCallBlock('tool-1', 'read_file', { path: 'a.ts' })

    expect(thinkingBlocks(store)[0].collapsed).toBe(true)
  })

  it('folds previous thinking when a new thinking block starts', () => {
    const store = createStreamingStore()

    store.getState().appendThinkingBlock('第一段思考')
    // 模拟阶段切换：中间非 thinking 块（如工具）后再出新思考
    store.getState().appendToolCallBlock('tool-1', 'search', { query: 'x' })
    store.getState().appendThinkingBlock('基于结果的第二段思考')

    const blocks = thinkingBlocks(store)
    expect(blocks).toHaveLength(2)
    // 上一思考块已折叠，新的思考块保持展开
    expect(blocks[0].collapsed).toBe(true)
    expect(blocks[1].collapsed).toBeUndefined()
  })

  it('folds all thinking blocks when the message is finalized (finishMessage)', () => {
    const store = createStreamingStore()

    store.getState().appendThinkingBlock('只有思考，没有正文的回复')
    expect(thinkingBlocks(store)[0].collapsed).toBeUndefined()

    store.getState().finishMessage()

    const archived = store.getState().messages[store.getState().messages.length - 1]
    expect(archived.type).toBe('assistant')
    const archivedThinking = (archived.blocks ?? []).filter((b): b is ThinkingBlock => b.type === 'thinking')
    expect(archivedThinking[0].collapsed).toBe(true)
  })
})