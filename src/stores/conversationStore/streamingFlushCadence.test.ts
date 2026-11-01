/**
 * 流式文本缓冲 flush 节奏测试
 *
 * 锁定 appendTextBlock 的三个 flush 触发时机（防止回归为高延迟批量更新，
 * 详见 temp/streaming-mvp 卡顿分析）：
 * 1. 首 token 立即 flush（首字响应速度）
 * 2. 段落内部：STREAM_FLUSH_INTERVAL(50ms) 超时 flush（文字更新帧率 20fps）
 * 3. 缓冲区出现 \n\n：立即 flush（段落边界）
 * 4. finishMessage：强制 flush 残余 buffer（尾部文字不丢失）
 *
 * 以及 thinking 缓冲 flush 矩阵（C2 spec plans/c2-thinking-buffer-spec.md §三，
 * 与 _textBuffer 范式严格对称）：
 * 1. 纯 thinking 流：首 delta 立即出块；窗内多 delta 合并一次 flush
 * 2. thinking→text 切换：text 首 token 前 thinking 已落块并折叠
 * 3. text→thinking 交替：块序正确（text 先落，thinking 为新块）
 * 4. tool_call 到达前 thinking 先 flush
 * 5. finishMessage/session_end 兜底：缓冲不丢字（含中断场景）
 * 6. 迟到 token：isStreaming=false 后到达的 thinking 追加到最后消息
 * 7. 内容完整性：长思考（≥1000 delta）最终内容 === 逐 delta 顺序拼接
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversationStore } from './createConversationStore'
import type { StoreDeps } from './types'
import type { TextBlock, ThinkingBlock } from '@/types'

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

function lastTextContent(store: ReturnType<typeof createConversationStore>): string {
  const blocks = store.getState().currentMessage?.blocks ?? []
  const lastText = [...blocks].reverse().find((b): b is TextBlock => b.type === 'text')
  return lastText?.content ?? ''
}

function thinkingBlocksOf(store: ReturnType<typeof createConversationStore>): ThinkingBlock[] {
  const blocks = store.getState().currentMessage?.blocks ?? []
  return blocks.filter((b): b is ThinkingBlock => b.type === 'thinking')
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

describe('thinking buffer flush matrix (C2 spec §三)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createStreamingStore() {
    const store = createConversationStore('session-thinking-flush-test', createDeps())
    store.setState({ isStreaming: true })
    return store
  }

  it('1. pure thinking stream: first delta lands immediately, window deltas merge into one flush', () => {
    const store = createStreamingStore()
    let setCount = 0
    const unsubscribe = store.subscribe(() => {
      setCount++
    })

    store.getState().appendThinkingBlock('首')
    // 首 delta 立即出块（首响不延迟）
    expect(store.getState().currentMessage).not.toBeNull()
    expect(thinkingBlocksOf(store)[0].content).toBe('首')
    const counterAfterFirst = store.getState().streamingUpdateCounter
    const setsAfterFirst = setCount

    // 窗内多 delta：只进缓冲，不触发 set / counter（O(1) 追加）
    store.getState().appendThinkingBlock('续1')
    store.getState().appendThinkingBlock('续2')
    expect(store.getState().streamingUpdateCounter).toBe(counterAfterFirst)
    expect(setCount).toBe(setsAfterFirst)

    // 50ms 一次 flush 合并全部缓冲
    vi.advanceTimersByTime(50)
    expect(thinkingBlocksOf(store)).toHaveLength(1)
    expect(thinkingBlocksOf(store)[0].content).toBe('首续1续2')
    // counter 语义不变：仍由 flush 触发 +1（一次 flush 恰好 +1 / 一次 set，
    // 而非逐 delta 各 +1 —— 若回归为逐 delta set，此断言失败）
    expect(store.getState().streamingUpdateCounter).toBe(counterAfterFirst + 1)
    expect(setCount).toBe(setsAfterFirst + 1)

    unsubscribe()
  })

  it('2. thinking→text switch: buffered thinking lands and folds before the first text token', () => {
    const store = createStreamingStore()

    store.getState().appendThinkingBlock('思考前半')
    store.getState().appendThinkingBlock('思考后半') // 缓冲中
    // text 首 token 到达：appendTextBlock 入口先 flush thinking，fold 检查随后折叠
    store.getState().appendTextBlock('回答')

    // thinking 已完整落块并折叠（不等待 50ms 定时器）
    const thinking = thinkingBlocksOf(store)
    expect(thinking).toHaveLength(1)
    expect(thinking[0].content).toBe('思考前半思考后半')
    expect(thinking[0].collapsed).toBe(true)

    // text 仍在缓冲（首 token 之后的常规节奏），50ms 后落块于 thinking 之后
    expect(lastTextContent(store)).toBe('')
    vi.advanceTimersByTime(50)
    expect(lastTextContent(store)).toBe('回答')
  })

  it('3. text→thinking alternation: text lands first, later thinking becomes a new block', () => {
    const store = createStreamingStore()

    store.getState().appendTextBlock('答案开头') // 首 token 立即落块
    store.getState().appendTextBlock('答案结尾') // 缓冲
    store.getState().appendThinkingBlock('补充思考') // 入口先 flush 文本缓冲

    // text 先行落块（appendThinkingBlock 入口的 text flush，先于 thinking 落块）
    expect(lastTextContent(store)).toBe('答案开头答案结尾')

    // thinking 缓冲 50ms 后落为新块，块序 text→thinking
    vi.advanceTimersByTime(50)
    const blockTypes = store.getState().currentMessage!.blocks.map((b) => b.type)
    expect(blockTypes).toEqual(['text', 'thinking'])
  })

  it('4. tool_call arrival flushes buffered thinking first (block order preserved)', () => {
    const store = createStreamingStore()

    store.getState().appendThinkingBlock('需要调用工具')
    store.getState().appendThinkingBlock('：搜索资料') // 缓冲中
    store.getState().appendToolCallBlock('tool-1', 'search', { query: 'x' })

    // thinking 缓冲在 tool_call 落块前完整落块并折叠
    const blocks = store.getState().currentMessage!.blocks
    expect(blocks[0].type).toBe('thinking')
    expect((blocks[0] as ThinkingBlock).content).toBe('需要调用工具：搜索资料')
    expect((blocks[0] as ThinkingBlock).collapsed).toBe(true)
    expect(blocks[1].type).toBe('tool_call')
  })

  it('5. finishMessage flushes buffered thinking without losing characters (interrupt path included)', () => {
    const store = createStreamingStore()

    store.getState().appendThinkingBlock('中断前的思考')
    store.getState().appendThinkingBlock('——缓冲未落块部分')
    // 未到 50ms 即结束流（中断统一经 session_end → finishMessage 收束，buffer 仍有内容）
    const completed = store.getState().finishMessage()

    expect(completed).not.toBeNull()
    const thinking = (completed!.blocks ?? []).filter((b): b is ThinkingBlock => b.type === 'thinking')
    expect(thinking).toHaveLength(1)
    expect(thinking[0].content).toBe('中断前的思考——缓冲未落块部分')
    expect(store.getState().currentMessage).toBeNull()
  })

  it('6. late thinking delta after isStreaming=false appends to the last archived message', () => {
    const store = createStreamingStore()

    store.getState().appendThinkingBlock('已落块思考')
    store.getState().finishMessage()
    // 模拟 session_end 处理完成（eventHandler 在 finishMessage 之后置 isStreaming=false）
    store.setState({ isStreaming: false })

    // 迟到的 thinking delta：不允许静默丢弃，须并入最后一条助手消息
    store.getState().appendThinkingBlock('迟到的思考')

    expect(store.getState().currentMessage).toBeNull()
    const archived = store.getState().messages[store.getState().messages.length - 1]
    expect(archived.type).toBe('assistant')
    const thinking = (archived.blocks ?? []).filter((b): b is ThinkingBlock => b.type === 'thinking')
    expect(thinking[0].content).toBe('已落块思考迟到的思考')
    // 归档消息不得被迟到来重开思考面板
    expect(thinking[0].collapsed).toBe(true)
  })

  it('7. long thinking stream (1200 deltas): final content equals sequential concatenation (zero loss)', () => {
    const store = createStreamingStore()
    const parts: string[] = []

    for (let i = 0; i < 1200; i++) {
      const chunk = `d${i}·`
      parts.push(chunk)
      store.getState().appendThinkingBlock(chunk)
      // 周期性推进定时器：覆盖「flush→再缓冲→再 flush」多轮合并路径
      if (i % 200 === 199) vi.advanceTimersByTime(50)
    }
    // 收束点兜底 flush 残余缓冲
    store.getState().finishMessage()

    const archived = store.getState().messages[store.getState().messages.length - 1]
    const thinking = (archived.blocks ?? []).filter((b): b is ThinkingBlock => b.type === 'thinking')
    // 多轮 flush 只 merge 进同一思考块（阶段内无类型切换，不产生新块）
    expect(thinking).toHaveLength(1)
    expect(thinking[0].content).toBe(parts.join(''))
  })
})
