/**
 * 案例 1：并发 append 零丢失验证
 *
 * 验证假设 1：append-only 消息日志能解决并发写丢失
 *
 * 场景：
 * - 设备 A 和设备 B 同时往同一会话追加消息
 * - 验证最终读取到的消息数量正确、无重复、按 timestamp 排序
 * - 验证幂等：相同 messageId 重复追加不产生重复
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryMessageLog } from '../core/in-memory-log'
import type { MessageEntry } from '../core/types'

/** 生成消息条目 */
function makeEntry(
  id: string,
  conversationId: string,
  role: 'user' | 'assistant' | 'system',
  timestamp: number,
  deviceId: string,
  content: Record<string, unknown> = {},
): MessageEntry {
  return {
    id,
    conversationId,
    role,
    timestamp,
    deviceId,
    content,
    version: 1,
  }
}

describe('案例 1：并发 append 零丢失', () => {
  let log: InMemoryMessageLog
  const CONV_ID = 'conv-test-001'

  beforeEach(() => {
    log = new InMemoryMessageLog()
  })

  // ==========================================================================
  // 基础验证
  // ==========================================================================

  it('单设备追加 100 条消息 → 读取到 100 条', async () => {
    const promises: Promise<boolean>[] = []
    for (let i = 0; i < 100; i++) {
      promises.push(log.append(makeEntry(`M${i}`, CONV_ID, 'user', 1000 + i, 'device-A')))
    }
    await Promise.all(promises)

    const messages = await log.read(CONV_ID)
    expect(messages.length).toBe(100)
  })

  it('消息按 timestamp 升序排列', async () => {
    // 乱序追加
    await log.append(makeEntry('M3', CONV_ID, 'user', 3000, 'A'))
    await log.append(makeEntry('M1', CONV_ID, 'user', 1000, 'A'))
    await log.append(makeEntry('M2', CONV_ID, 'user', 2000, 'A'))

    const messages = await log.read(CONV_ID)
    expect(messages.map(m => m.id)).toEqual(['M1', 'M2', 'M3'])
  })

  // ==========================================================================
  // 并发验证（核心）
  // ==========================================================================

  it('两设备并发各写 100 条 → 最终 200 条无重复', async () => {
    const promises: Promise<boolean>[] = []

    // 设备 A：M_A000 ~ M_A099
    for (let i = 0; i < 100; i++) {
      promises.push(
        log.append(makeEntry(`A${i}`, CONV_ID, 'user', 1000 + i, 'device-A')),
      )
    }
    // 设备 B：M_B000 ~ M_B099
    for (let i = 0; i < 100; i++) {
      promises.push(
        log.append(makeEntry(`B${i}`, CONV_ID, 'assistant', 1000 + i, 'device-B')),
      )
    }

    await Promise.all(promises)

    const messages = await log.read(CONV_ID)
    expect(messages.length).toBe(200)

    // 无重复 ID
    const ids = new Set(messages.map(m => m.id))
    expect(ids.size).toBe(200)
  })

  it('两设备并发写入相同 ID 的消息 → 幂等去重', async () => {
    // 设备 A 和 B 都尝试写入相同 messageId 的消息
    const sharedEntry = makeEntry('shared-001', CONV_ID, 'user', 1000, 'device-A', { text: 'hello' })
    const dupEntry = makeEntry('shared-001', CONV_ID, 'user', 1000, 'device-B', { text: 'hello' })

    const [r1, r2] = await Promise.all([
      log.append(sharedEntry),
      log.append(dupEntry),
    ])

    // 一个成功一个跳过（幂等）
    expect(r1 === true || r2 === true).toBe(true)
    expect(r1 === false || r2 === false).toBe(true)

    const messages = await log.read(CONV_ID)
    expect(messages.length).toBe(1)
    expect(messages[0].id).toBe('shared-001')
  })

  it('两设备并发写入相同 ID 但不同 content → 先到先得', async () => {
    // 相同 messageId 不同内容（模拟两设备同时发消息）
    const entryA = makeEntry('conflict-001', CONV_ID, 'user', 1000, 'A', { text: 'from A' })
    const entryB = makeEntry('conflict-001', CONV_ID, 'user', 1000, 'B', { text: 'from B' })

    await Promise.all([
      log.append(entryA),
      log.append(entryB),
    ])

    const messages = await log.read(CONV_ID)
    expect(messages.length).toBe(1)
    // 第一个写入的内容保留（不保证哪个先到，但只保留一个）
    expect(messages[0].id).toBe('conflict-001')
    expect(['from A', 'from B']).toContain(messages[0].content.text)
  })

  // ==========================================================================
  // 跨会话隔离
  // ==========================================================================

  it('不同会话的消息互不干扰', async () => {
    await Promise.all([
      log.append(makeEntry('C1-M1', 'conv-1', 'user', 1000, 'A')),
      log.append(makeEntry('C2-M1', 'conv-2', 'user', 1000, 'A')),
      log.append(makeEntry('C1-M2', 'conv-1', 'user', 2000, 'A')),
      log.append(makeEntry('C2-M2', 'conv-2', 'user', 2000, 'B')),
    ])

    const c1 = await log.read('conv-1')
    const c2 = await log.read('conv-2')

    expect(c1.length).toBe(2)
    expect(c2.length).toBe(2)
    expect(c1.every(m => m.conversationId === 'conv-1')).toBe(true)
    expect(c2.every(m => m.conversationId === 'conv-2')).toBe(true)
  })

  // ==========================================================================
  // 修订链验证
  // ==========================================================================

  it('revise 追加新版本，旧版本保留', async () => {
    await log.append(makeEntry('R1', CONV_ID, 'assistant', 1000, 'A', { text: '初始' }))

    await log.revise('R1', { text: '第1次修订' })
    await log.revise('R1', { text: '第2次修订' })

    const history = await log.readHistory('R1')
    expect(history.length).toBe(3)
    expect(history[0].content.text).toBe('初始')
    expect(history[1].content.text).toBe('第1次修订')
    expect(history[2].content.text).toBe('第2次修订')

    const latest = await log.getLatest('R1')
    expect(latest?.content.text).toBe('第2次修订')
    expect(latest?.version).toBe(3)
  })

  it('read 返回最新版本而非历史版本', async () => {
    await log.append(makeEntry('R2', CONV_ID, 'assistant', 1000, 'A', { text: 'v1' }))
    await log.revise('R2', { text: 'v2' })

    const messages = await log.read(CONV_ID)
    expect(messages.length).toBe(1)
    expect(messages[0].content.text).toBe('v2')
    expect(messages[0].version).toBe(2)
  })

  // ==========================================================================
  // 性能验证
  // ==========================================================================

  it('1000 条并发 append 性能 < 100ms', async () => {
    const start = performance.now()
    const promises: Promise<boolean>[] = []
    for (let i = 0; i < 1000; i++) {
      promises.push(log.append(makeEntry(`P${i}`, CONV_ID, 'user', i, `device-${i % 3}`)))
    }
    await Promise.all(promises)
    const elapsed = performance.now() - start

    console.log(`1000 条并发 append 耗时: ${elapsed.toFixed(1)}ms`)
    expect(elapsed).toBeLessThan(100)

    const messages = await log.read(CONV_ID)
    expect(messages.length).toBe(1000)
  })

  it('100 次连续 revise（模拟流式 delta）性能 < 50ms', async () => {
    await log.append(makeEntry('stream-1', CONV_ID, 'assistant', 1000, 'A', { text: '' }))

    const start = performance.now()
    for (let i = 0; i < 100; i++) {
      await log.revise('stream-1', { text: `累积到第${i + 1}个字符` })
    }
    const elapsed = performance.now() - start

    console.log(`100 次 revise 耗时: ${elapsed.toFixed(1)}ms`)
    expect(elapsed).toBeLessThan(50)

    const latest = await log.getLatest('stream-1')
    expect(latest?.content.text).toBe('累积到第100个字符')
    expect(latest?.version).toBe(101)
  })

  // ==========================================================================
  // 读取选项
  // ==========================================================================

  it('read with afterTimestamp 只返回之后的消息', async () => {
    await log.append(makeEntry('T1', CONV_ID, 'user', 1000, 'A'))
    await log.append(makeEntry('T2', CONV_ID, 'user', 2000, 'A'))
    await log.append(makeEntry('T3', CONV_ID, 'user', 3000, 'A'))

    const after = await log.read(CONV_ID, { afterTimestamp: 1500 })
    expect(after.length).toBe(2)
    expect(after.map(m => m.id)).toEqual(['T2', 'T3'])
  })

  it('read with limit 只返回前 N 条', async () => {
    for (let i = 0; i < 10; i++) {
      await log.append(makeEntry(`L${i}`, CONV_ID, 'user', 1000 + i, 'A'))
    }

    const limited = await log.read(CONV_ID, { limit: 3 })
    expect(limited.length).toBe(3)
    expect(limited.map(m => m.id)).toEqual(['L0', 'L1', 'L2'])
  })

  // ==========================================================================
  // 删除
  // ==========================================================================

  it('deleteByConversation 清除该会话的所有消息', async () => {
    await log.append(makeEntry('D1', 'conv-del', 'user', 1000, 'A'))
    await log.append(makeEntry('D2', 'conv-del', 'user', 2000, 'A'))
    await log.append(makeEntry('D3', 'conv-other', 'user', 1000, 'A'))

    await log.deleteByConversation('conv-del')

    const deleted = await log.read('conv-del')
    const kept = await log.read('conv-other')

    expect(deleted.length).toBe(0)
    expect(kept.length).toBe(1)
  })

  // ==========================================================================
  // 边界场景
  // ==========================================================================

  it('空会话 read 返回空数组', async () => {
    const messages = await log.read('nonexistent')
    expect(messages).toEqual([])
  })

  it('revise 不存在的消息 → 抛错', async () => {
    await expect(log.revise('nonexistent', { text: 'x' })).rejects.toThrow()
  })

  it('getLatest 不存在的消息 → null', async () => {
    const result = await log.getLatest('nonexistent')
    expect(result).toBeNull()
  })
})
