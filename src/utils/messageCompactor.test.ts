/**
 * MessageCompactor 单元测试
 *
 * 覆盖：
 * - assistant / user 消息的压缩与恢复主路径
 * - 不可压缩消息（system / tool / tool_group 顶层消息）不应占用快照额度
 * - 快照 LRU 不应被不可压缩消息污染（回归：见下方说明）
 *
 * 回归背景：
 *   早期实现中 compactMessage() 会对所有消息无条件 saveSnapshot()，但
 *   system / tool / tool_group 顶层消息走 default 分支原样返回（不压缩）。
 *   这些「白存」的快照会持续 touch 到 LRU 队尾且永不淘汰，把真正被压缩的
 *   assistant/user 快照挤出 MAX_SNAPSHOTS，导致用户滚回历史时无法恢复，
 *   只能看到被截断的压缩态（工具输出/思考/正文丢失）。
 */

import { describe, it, expect } from 'vitest'
import { MessageCompactor, isCompacted } from './messageCompactor'
import type { AssistantChatMessage, SystemChatMessage, UserChatMessage } from '@/types/chat'

function makeAssistant(id: string): AssistantChatMessage {
  return {
    id,
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00.000Z',
    blocks: [{ type: 'text', content: 'X'.repeat(5000) }] as AssistantChatMessage['blocks'],
  }
}

function makeUser(id: string): UserChatMessage {
  return {
    id,
    type: 'user',
    timestamp: '2026-01-01T00:00:00.000Z',
    content: 'U'.repeat(1000),
  }
}

function makeSystem(id: string): SystemChatMessage {
  return {
    id,
    type: 'system',
    timestamp: '2026-01-01T00:00:00.000Z',
    content: 'system-noise '.repeat(50),
  }
}

describe('MessageCompactor', () => {
  it('assistant 消息：压缩后正文截断，可从快照完整恢复', () => {
    const c = new MessageCompactor()
    const original = makeAssistant('a1')
    const compacted = c.compactMessage(original)

    expect(isCompacted(compacted)).toBe(true)
    expect(compacted).not.toBe(original)

    const restored = c.hydrateMessage(compacted)
    expect(isCompacted(restored)).toBe(false)
    expect((restored as AssistantChatMessage).blocks[0]).toMatchObject({ content: 'X'.repeat(5000) })
  })

  it('user 消息：压缩后 content 截断，可从快照完整恢复', () => {
    const c = new MessageCompactor()
    const original = makeUser('u1')
    const compacted = c.compactMessage(original)

    expect(isCompacted(compacted)).toBe(true)
    expect((compacted as UserChatMessage).content.length).toBeLessThan(1000)

    const restored = c.hydrateMessage(compacted)
    expect((restored as UserChatMessage).content).toBe('U'.repeat(1000))
  })

  it('system 消息：原样返回，且不占用快照额度', () => {
    const c = new MessageCompactor()
    const sys = makeSystem('s1')
    const out = c.compactMessage(sys)

    // 不压缩是正确的：renderChatMessage 会原样渲染 SystemBubble
    expect(isCompacted(out)).toBe(false)
    expect(out).toBe(sys) // 同引用，内容零变化

    // 既然没压缩，就不该白存快照占用 LRU 额度
    expect(c.snapshotCount).toBe(0)
  })

  it('回归：大量 system 消息不应把 assistant 的快照挤出 LRU', () => {
    const c = new MessageCompactor()

    // 1 条 assistant 被压缩，快照存入
    const compactedA = c.compactMessage(makeAssistant('a1'))
    expect(isCompacted(compactedA)).toBe(true)

    // 模拟加载历史长会话后滚动：20 条 system 顶层消息经过 compactMessage
    // （MAX_SNAPSHOTS = 20，足以在「白存快照」的旧实现下挤出 a1）
    for (let i = 0; i < 20; i++) {
      c.compactMessage(makeSystem(`sys-${i}`))
    }

    // 用户滚回去看 a1，应能从快照恢复
    const restored = c.hydrateMessage(compactedA)
    expect(isCompacted(restored)).toBe(false)
    expect((restored as AssistantChatMessage).blocks[0]).toMatchObject({ content: 'X'.repeat(5000) })
  })
})
