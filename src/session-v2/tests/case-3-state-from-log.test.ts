/**
 * 案例 3：状态从日志计算验证
 *
 * 验证假设 3：状态从事件日志计算比存储值更可靠
 *
 * 核心命题：
 * - isRunning = 存在 session_start 但无配对 session_end → 计算结果
 * - 不存储 isStreaming 布尔值，永远从事件日志推导
 * - 跨设备查询：B 设备调 getStatus 能得到与后端一致的结果
 * - 崩溃恢复：无 session_end 的会话能被正确识别
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemorySessionEventLog, InMemoryStateArbiter } from '../core/in-memory-state'
import type { SessionEventEntry } from '../core/types'

let seqCounter = 0

function makeEvent(
  conversationId: string,
  type: 'session_start' | 'session_end' | 'error',
  deviceId: string,
  timestamp: number,
  extra?: Partial<SessionEventEntry>,
): SessionEventEntry {
  return {
    id: `evt-${++seqCounter}`,
    conversationId,
    type,
    timestamp,
    deviceId,
    seq: seqCounter,
    ...extra,
  }
}

describe('案例 3：状态从日志计算', () => {
  let eventLog: InMemorySessionEventLog
  let arbiter: InMemoryStateArbiter

  beforeEach(() => {
    seqCounter = 0
    eventLog = new InMemorySessionEventLog()
    arbiter = new InMemoryStateArbiter(eventLog)
  })

  // ==========================================================================
  // 基础：状态计算
  // ==========================================================================

  it('无事件 → running=false', async () => {
    const status = await arbiter.getStatus('conv-1')
    expect(status.running).toBe(false)
    expect(status.startedAt).toBeNull()
    expect(status.endedAt).toBeNull()
    expect(status.error).toBeNull()
  })

  it('只有 session_start → running=true', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'device-A', 1000))

    const status = await arbiter.getStatus('conv-1')
    expect(status.running).toBe(true)
    expect(status.startedAt).toBe(1000)
    expect(status.startedByDevice).toBe('device-A')
    expect(status.endedAt).toBeNull()
  })

  it('session_start → session_end → running=false', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))
    await eventLog.append(makeEvent('conv-1', 'session_end', 'A', 2000, { reason: 'completed' }))

    const status = await arbiter.getStatus('conv-1')
    expect(status.running).toBe(false)
    expect(status.endedAt).toBe(2000)
  })

  it('session_start → error → session_end(reason=error) → running=false, error 有值', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))
    await eventLog.append(makeEvent('conv-1', 'error', 'A', 1500, { errorMessage: '模型超时' }))
    await eventLog.append(makeEvent('conv-1', 'session_end', 'A', 2000, { reason: 'error' }))

    const status = await arbiter.getStatus('conv-1')
    expect(status.running).toBe(false)
    expect(status.error).toBe('模型超时')
  })

  // ==========================================================================
  // 多轮：start → end → start → end
  // ==========================================================================

  it('多轮会话：第二轮 start 后 running=true', async () => {
    // 第一轮
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))
    await eventLog.append(makeEvent('conv-1', 'session_end', 'A', 2000, { reason: 'completed' }))

    // 第二轮
    await eventLog.append(makeEvent('conv-1', 'session_start', 'B', 3000))

    const status = await arbiter.getStatus('conv-1')
    expect(status.running).toBe(true)
    expect(status.startedAt).toBe(3000)
    expect(status.startedByDevice).toBe('B')
    expect(status.lastEventSeq).toBe(3)
  })

  it('多轮会话：第二轮 start 后 end → running=false', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))
    await eventLog.append(makeEvent('conv-1', 'session_end', 'A', 2000))
    await eventLog.append(makeEvent('conv-1', 'session_start', 'B', 3000))
    await eventLog.append(makeEvent('conv-1', 'session_end', 'B', 4000))

    const status = await arbiter.getStatus('conv-1')
    expect(status.running).toBe(false)
    expect(status.endedAt).toBe(4000)
  })

  // ==========================================================================
  // 跨设备查询
  // ==========================================================================

  it('设备A 发起 session_start → 设备B 查询 → running=true', async () => {
    // 设备 A 追加 session_start
    await eventLog.append(makeEvent('conv-1', 'session_start', 'device-A', 1000))

    // 设备 B 通过同一仲裁器查询（模拟调后端）
    const status = await arbiter.getStatus('conv-1')

    expect(status.running).toBe(true)
    expect(status.startedByDevice).toBe('device-A')
  })

  it('设备A 发起 → 设备B 查询 → 设备A 结束 → 设备B 再查询 → running=false', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))

    const s1 = await arbiter.getStatus('conv-1')
    expect(s1.running).toBe(true)

    await eventLog.append(makeEvent('conv-1', 'session_end', 'A', 2000))

    const s2 = await arbiter.getStatus('conv-1')
    expect(s2.running).toBe(false)
  })

  // ==========================================================================
  // 崩溃恢复
  // ==========================================================================

  it('崩溃场景：有 session_start 无 session_end → running=true（诚实反映）', async () => {
    // 模拟进程崩溃：只追加了 session_start，没有 session_end
    await eventLog.append(makeEvent('conv-crash', 'session_start', 'A', 1000))

    const status = await arbiter.getStatus('conv-crash')
    expect(status.running).toBe(true)
    // 这诚实地反映了"会话可能在运行也可能已崩溃但我们不知道"
  })

  it('崩溃恢复：后端补插 session_end(reason=error) → running=false', async () => {
    await eventLog.append(makeEvent('conv-crash', 'session_start', 'A', 1000))

    // 后端启动时扫描无配对 session_end 的会话，补插一条
    await eventLog.append(makeEvent('conv-crash', 'session_end', 'system', 5000, {
      reason: 'error',
      errorMessage: '进程崩溃，会话未正常结束',
    }))

    const status = await arbiter.getStatus('conv-crash')
    expect(status.running).toBe(false)
    expect(status.endedAt).toBe(5000)
    expect(status.error).toBe('进程崩溃，会话未正常结束')
  })

  // ==========================================================================
  // 仲裁：requestStart / requestInterrupt
  // ==========================================================================

  it('requestStart：会话已 running → 拒绝', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))

    const result = await arbiter.requestStart('conv-1', 'B')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('运行中')
  })

  it('requestStart：会话 idle → 允许', async () => {
    const result = await arbiter.requestStart('conv-1', 'A')
    expect(result.ok).toBe(true)
  })

  it('requestInterrupt：会话 running → 允许', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))

    const result = await arbiter.requestInterrupt('conv-1', 'B')
    expect(result.ok).toBe(true)
  })

  it('requestInterrupt：会话 idle → 拒绝', async () => {
    const result = await arbiter.requestInterrupt('conv-1', 'A')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('未在运行')
  })

  // ==========================================================================
  // 双设备并发仲裁
  // ==========================================================================

  it('两设备同时 requestStart → 只有一个成功', async () => {
    // 先追加一个 session_start 模拟 A 抢先
    await eventLog.append(makeEvent('conv-race', 'session_start', 'A', 1000))

    // B 此时请求 start
    const resultB = await arbiter.requestStart('conv-race', 'B')
    expect(resultB.ok).toBe(false)
  })

  // ==========================================================================
  // resume：按 seq 恢复事件
  // ==========================================================================

  it('readAfterSeq：返回指定 seq 之后的所有事件', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000)) // seq=1
    await eventLog.append(makeEvent('conv-1', 'error', 'A', 1500))         // seq=2
    await eventLog.append(makeEvent('conv-1', 'session_end', 'A', 2000))   // seq=3
    await eventLog.append(makeEvent('conv-2', 'session_start', 'B', 3000)) // seq=4

    const after = await eventLog.readAfterSeq(2)
    expect(after.length).toBe(2)
    expect(after[0].seq).toBe(3)
    expect(after[1].seq).toBe(4)
  })

  it('readAfterSeq(0)：返回全部事件', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))
    await eventLog.append(makeEvent('conv-1', 'session_end', 'A', 2000))

    const all = await eventLog.readAfterSeq(0)
    expect(all.length).toBe(2)
  })

  // ==========================================================================
  // 性能
  // ==========================================================================

  it('1000 条事件 getStatus 计算 < 5ms', async () => {
    // 写入 500 轮（start + end）
    for (let i = 0; i < 500; i++) {
      await eventLog.append(makeEvent('conv-perf', 'session_start', 'A', i * 100))
      await eventLog.append(makeEvent('conv-perf', 'session_end', 'A', i * 100 + 50))
    }

    const start = performance.now()
    const status = await arbiter.getStatus('conv-perf')
    const elapsed = performance.now() - start

    console.log(`1000 条事件 getStatus: ${elapsed.toFixed(2)}ms`)
    expect(elapsed).toBeLessThan(5)
    expect(status.running).toBe(false)
    expect(status.lastEventSeq).toBe(1000)
  })

  // ==========================================================================
  // 幂等
  // ==========================================================================

  it('相同事件 ID 重复追加 → 幂等跳过', async () => {
    const evt = makeEvent('conv-1', 'session_start', 'A', 1000)
    const r1 = await eventLog.append(evt)
    const r2 = await eventLog.append(evt)

    expect(r1).toBe(true)
    expect(r2).toBe(false)

    const events = await eventLog.read('conv-1')
    expect(events.length).toBe(1)
  })

  // ==========================================================================
  // 隔离
  // ==========================================================================

  it('不同会话的事件互不干扰', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))
    await eventLog.append(makeEvent('conv-2', 'session_start', 'B', 2000))

    const s1 = await arbiter.getStatus('conv-1')
    const s2 = await arbiter.getStatus('conv-2')

    expect(s1.running).toBe(true)
    expect(s1.startedByDevice).toBe('A')
    expect(s2.running).toBe(true)
    expect(s2.startedByDevice).toBe('B')
  })

  it('deleteByConversation 只删目标会话事件', async () => {
    await eventLog.append(makeEvent('conv-1', 'session_start', 'A', 1000))
    await eventLog.append(makeEvent('conv-2', 'session_start', 'B', 2000))

    await eventLog.deleteByConversation('conv-1')

    const s1 = await arbiter.getStatus('conv-1')
    const s2 = await arbiter.getStatus('conv-2')
    expect(s1.running).toBe(false)
    expect(s2.running).toBe(true)
  })
})
