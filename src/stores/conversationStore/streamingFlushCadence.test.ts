/**
 * 流式文本缓冲 flush 节奏测试
 *
 * 锁定 appendTextBlock 的三个 flush 触发时机（防止回归为高延迟批量更新，
 * 详见 temp/streaming-mvp 卡顿分析）：
 * 1. 首 token 立即 flush（首字响应速度）
 * 2. 段落内部：STREAM_FLUSH_INTERVAL(50ms) 超时 flush（文字更新帧率 20fps）
 * 3. 缓冲区出现 \n\n：立即 flush（段落边界）
 * 4. finishMessage：强制 flush 残余 buffer（尾部文字不丢失）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversationStore } from './createConversationStore'
import type { StoreDeps } from './types'
import type { TextBlock } from '@/types'

function createDeps(): StoreDeps {
  return {
    getConfig: () => ({ defaultEngine: 'codex' }),
    getWorkspace: () => null,
    getContextWorkspaceIds: () => [],
    getAllWorkspaces: () => [],
    getEventRouter: () => ({}) as StoreDeps['getEventRouter'] extends () => infer T ? T : never,
    contextId: 'test-context',
  }
}

function lastTextContent(store: ReturnType<typeof createConversationStore>): string {
  const blocks = store.getState().currentMessage?.blocks ?? []
  const lastText = [...blocks].reverse().find((b): b is TextBlock => b.type === 'text')
  return lastText?.content ?? ''
}

describe('streaming text flush cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createStreamingStore() {
    const store = createConversationStore('session-flush-test', createDeps())
    store.setState({ isStreaming: true })
    return store
  }

  it('flushes the first token immediately (fast first-paint)', () => {
    const store = createStreamingStore()

    store.getState().appendTextBlock('你好')

    expect(store.getState().currentMessage).not.toBeNull()
    expect(lastTextContent(store)).toBe('你好')
  })

  it('buffers in-paragraph tokens and flushes within 50ms (not 200ms)', () => {
    const store = createStreamingStore()

    store.getState().appendTextBlock('首段')
    store.getState().appendTextBlock('，后续内容')
    store.getState().appendTextBlock('继续追加')

    // 缓冲期内不更新（仍是首 token 内容）
    expect(lastTextContent(store)).toBe('首段')

    // 49ms：尚未到 flush 间隔
    vi.advanceTimersByTime(49)
    expect(lastTextContent(store)).toBe('首段')

    // 50ms：超时保护触发 flush（若回归为 200ms 此断言会失败）
    vi.advanceTimersByTime(1)
    expect(lastTextContent(store)).toBe('首段，后续内容继续追加')
  })

  it('flushes immediately when buffer contains a paragraph break (\\n\\n)', () => {
    const store = createStreamingStore()

    store.getState().appendTextBlock('第一段')
    store.getState().appendTextBlock('结尾\n\n第二段开头')

    // 无需推进定时器，段落边界立即 flush
    expect(lastTextContent(store)).toBe('第一段结尾\n\n第二段开头')
  })

  it('does not lose buffered tail text on finishMessage', () => {
    const store = createStreamingStore()

    store.getState().appendTextBlock('开头')
    store.getState().appendTextBlock('，缓冲中的尾部文字')

    // 未到 50ms 即结束流（buffer 仍有未 flush 内容）
    const completed = store.getState().finishMessage()

    expect(completed).not.toBeNull()
    const textBlock = completed?.blocks.find((b): b is TextBlock => b.type === 'text')
    expect(textBlock?.content).toBe('开头，缓冲中的尾部文字')
    expect(store.getState().currentMessage).toBeNull()
  })

  it('cancels the pending flush timer after a paragraph-break flush (no double flush)', () => {
    const store = createStreamingStore()

    store.getState().appendTextBlock('首段')
    store.getState().appendTextBlock('缓冲文字')      // 启动 50ms 定时器
    store.getState().appendTextBlock('\n\n新段落')    // 段落边界立即 flush，应清除定时器

    const afterParagraphFlush = lastTextContent(store)
    expect(afterParagraphFlush).toBe('首段缓冲文字\n\n新段落')

    // 推进超时间隔，不应产生额外内容变化（定时器已被清除，buffer 为空）
    vi.advanceTimersByTime(100)
    expect(lastTextContent(store)).toBe(afterParagraphFlush)
  })
})
