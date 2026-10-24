/**
 * RemoteSessionFollower 推导逻辑单测（跨端交互 v2）
 *
 * 锁定 seedRunningSessions 的纯函数核心 deriveSessionsFromEvents：
 * 事件形状对齐后端 SessionEventEntry 的 serde 输出（camelCase + type 显式 rename）。
 * 场景覆盖用户实际数据形态（2026-10-24 排查：maxSeq=41、simple-ai-1072 start 无 end）。
 */

import { describe, it, expect } from 'vitest'
import { deriveSessionsFromEvents, type RemoteLifecycleEvent } from '@/services/remoteSessionFollower'

/** 对齐后端 serde 输出的事件构造器 */
function ev(
  seq: number,
  conversationId: string,
  type: 'session_start' | 'session_end' | 'error',
  ts = 1792816780558 + seq,
  reason?: string,
): RemoteLifecycleEvent {
  return {
    id: `core-${type}-${seq}`,
    conversationId,
    type,
    timestamp: ts,
    deviceId: 'core',
    seq,
    reason: reason ?? null,
    errorMessage: null,
  }
}

describe('deriveSessionsFromEvents（跨端跟随发现推导）', () => {
  it('start 无 end → running（用户实测场景：simple-ai-1072 在 maxSeq=41 处 running）', () => {
    // 复刻 2026-10-24 用户 dev 库真实事件序列（seq 39-41）
    const events = [
      ev(39, 'session-074c432f-b0f4-4b1a-ad07-455bcf555916', 'session_start'),
      ev(40, 'session-074c432f-b0f4-4b1a-ad07-455bcf555916', 'session_end'),
      ev(41, 'simple-ai-1792816780558-1072', 'session_start'),
    ]
    const state = deriveSessionsFromEvents(events)
    expect(state.size).toBe(2)
    expect(state.get('simple-ai-1792816780558-1072')?.status).toBe('running')
    expect(state.get('session-074c432f-b0f4-4b1a-ad07-455bcf555916')?.status).toBe('ended')
  })

  it('start→end 成对收尾；后到 start 重新拉起（后端重启补写场景）', () => {
    const events = [
      ev(1, 'c1', 'session_start'),
      ev(2, 'c1', 'session_end', 100, 'completed'),
      ev(3, 'c1', 'session_start'),
    ]
    const state = deriveSessionsFromEvents(events)
    expect(state.get('c1')?.status).toBe('running')
    expect(state.get('c1')?.startedAt).toBe(ev(3, 'c1', 'session_start').timestamp)
  })

  it('error 事件同样收尾', () => {
    const state = deriveSessionsFromEvents([
      ev(1, 'c1', 'session_start'),
      ev(2, 'c1', 'error', 100, 'panic'),
    ])
    expect(state.get('c1')?.status).toBe('ended')
    expect(state.get('c1')?.endReason).toBe('panic')
  })

  it('过滤伪会话：pending-（B1.h 即时落盘）与 start-gate-（start 排他占位）', () => {
    const state = deriveSessionsFromEvents([
      ev(1, 'pending-session-abc', 'session_start'),
      ev(2, 'start-gate-session-abc', 'session_start'),
      ev(3, 'real-conv', 'session_start'),
    ])
    expect(state.size).toBe(1)
    expect(state.has('real-conv')).toBe(true)
  })

  it('空事件序列返回空集合（新库 / web 端首启）', () => {
    expect(deriveSessionsFromEvents([]).size).toBe(0)
  })
})
