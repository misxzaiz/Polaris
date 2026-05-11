import { describe, expect, it } from 'vitest'

import type { ContentBlock } from '@/types/chat'

import {
  SESSION_SUMMARY_MAX_CHARS,
  blockToText,
  truncateSummary,
} from './longGoalSessionTracker'

describe('blockToText', () => {
  it('保留 text 块原文', () => {
    const block: ContentBlock = { type: 'text', content: '本轮结果：S5 闭环' } as ContentBlock
    expect(blockToText(block)).toBe('本轮结果：S5 闭环')
  })

  it('剥离 thinking 块（避免 chain-of-thought 泄漏到长期记忆）', () => {
    // 参见 temp/bugfix/20260511.md 来源 3：旧实现把 thinking 块直接当正文落盘，
    // 导致 sessions/{ts}.md 充斥 "I'm checking..."、"I need to..." 等独白，
    // 下一轮 prompt 的「上一轮摘要」段会再次注入这些垃圾。
    const block: ContentBlock = {
      type: 'thinking',
      content: "I'm checking the latest sprint goals to see what needs to be done...",
    } as ContentBlock
    expect(blockToText(block)).toBe('')
  })

  it('plan_mode 块降级为 description / title', () => {
    const withDescription: ContentBlock = {
      type: 'plan_mode',
      description: 'plan body',
      title: 'plan title',
    } as ContentBlock
    expect(blockToText(withDescription)).toBe('plan body')

    const onlyTitle: ContentBlock = {
      type: 'plan_mode',
      description: '',
      title: 'fallback title',
    } as ContentBlock
    expect(blockToText(onlyTitle)).toBe('fallback title')
  })
})

describe('truncateSummary', () => {
  it('短摘要原样返回', () => {
    const text = '## 本轮结果\nSprint 5 闭环\n## 下一步\nR-Final 复审'
    expect(truncateSummary(text, 1500)).toBe(text)
  })

  it('超长摘要按头尾各半截断并保留中段省略号', () => {
    const head = '本轮结果起点'.repeat(200) // 1200 字符
    const tail = '下一步终点'.repeat(200) // 1000 字符
    const text = head + tail
    const truncated = truncateSummary(text, 1500)
    expect(truncated.length).toBeLessThan(text.length)
    expect(truncated).toContain('已省略中段')
    expect(truncated.startsWith('本轮结果起点')).toBe(true)
    expect(truncated.endsWith('下一步终点')).toBe(true)
  })

  it('使用默认上限常量 SESSION_SUMMARY_MAX_CHARS = 1500', () => {
    expect(SESSION_SUMMARY_MAX_CHARS).toBe(1500)
  })

  it('恰好等于上限的摘要不截断', () => {
    const text = 'a'.repeat(1500)
    expect(truncateSummary(text, 1500)).toBe(text)
  })
})
