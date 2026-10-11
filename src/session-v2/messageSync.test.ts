/**
 * messageSync 单测 — S3 阶段 1 发送双写（渐进方案 A）
 *
 * 覆盖核心约束：
 * 1. conversationId 为 null（首轮）→ 不写（对齐「首轮回填」，无占位垃圾）；
 * 2. conversationId 非空 → 全量写 user+assistant 到后端 SQLite（经 V2MessageLog）；
 * 3. 幂等水位：同 id 不重复写（symbol/log 双重保护）；
 * 4. 转换：role 映射正确、content 为完整 ChatMessage JSON、deviceId 注入；
 * 5. 失败不抛（fire-and-forget 语义），部分失败只 log。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { syncSessionToShared, clearSyncedWatermark, syncStreamingMessage } from './messageSync'
import type { ChatMessage } from '@/types/chat'
import { getDeviceId } from '@/utils/deviceId'
import { invoke } from '@/services/transport'

// ============================================================================
// mock 统一 transport：V2MessageLog 依赖 invoke 命令契约
// ============================================================================

/** 伪后端：捕获 message_append 调用并模拟幂等语义 */
const appended: Array<Record<string, unknown>> = []
const appendedIds = new Set<string>()
/** 伪后端：捕获 message_revise 调用（记录 id + content + 版本演进） */
const revised: Array<{ id: string; content: unknown }> = []
const versionByMessage = new Map<string, number>()

vi.mock('@/services/transport', () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'message_append') {
      const entry = (args ?? {}) as Record<string, unknown>
      const key = `${entry.id}#${entry.version ?? 1}`
      if (appendedIds.has(key)) return Promise.resolve(false)
      appendedIds.add(key)
      appended.push(entry)
      versionByMessage.set(String(entry.id), 1)
      return Promise.resolve(true)
    }
    if (cmd === 'message_revise') {
      const id = String(args?.id)
      const version = (versionByMessage.get(id) ?? 0) + 1
      versionByMessage.set(id, version)
      revised.push({ id, content: args?.content })
      return Promise.resolve(version)
    }
    return Promise.reject(new Error(`Unknown command: ${cmd}`))
  }),
}))

function userMsg(id: string, content: string): ChatMessage {
  return {
    id,
    type: 'user',
    content,
    timestamp: '2026-10-11T00:00:00.000Z',
  }
}

function assistantMsg(id: string, blocks: unknown[] = [{ type: 'text', text: '回复' }]): ChatMessage {
  return {
    id,
    type: 'assistant',
    engineId: 'claude-code',
    blocks,
    content: '回复',
    timestamp: '2026-10-11T00:01:00.000Z',
  }
}

function streamingAssistantMsg(id: string, text: string): ChatMessage {
  return {
    id,
    type: 'assistant',
    engineId: 'claude-code',
    blocks: [{ type: 'text', content: text }],
    isStreaming: true,
    timestamp: '2026-10-11T00:01:00.000Z',
  }
}

describe('syncSessionToShared', () => {
  beforeEach(() => {
    appended.length = 0
    appendedIds.clear()
    revised.length = 0
    versionByMessage.clear()
    clearSyncedWatermark('s1')
  })

  afterEach(() => {
    clearSyncedWatermark('s1')
  })

  it('conversationId 为 null（首轮）→ 不写后端（跳过）', async () => {
    const ok = await syncSessionToShared('s1', null, [userMsg('u1', '你好')])
    expect(ok).toBe(false)
    expect(appended.length).toBe(0)
  })

  it('conversationId 非空 → 全量写 user+assistant', async () => {
    const msgs = [userMsg('u1', '你好'), assistantMsg('a1')]
    const ok = await syncSessionToShared('s1', 'conv-1', msgs)
    expect(ok).toBe(true)
    expect(appended.length).toBe(2)
    expect(appended[0].id).toBe('u1')
    expect(appended[1].id).toBe('a1')
    // conversationId 透传
    expect(appended[0].conversationId).toBe('conv-1')
    expect(appended[1].conversationId).toBe('conv-1')
  })

  it('role 映射：user→user、assistant→assistant、tool/system→system', async () => {
    const msgs: ChatMessage[] = [
      userMsg('u1', 'hi'),
      assistantMsg('a1'),
      { id: 't1', type: 'tool', timestamp: '2026-10-11T00:02:00.000Z', content: {} } as unknown as ChatMessage,
      { id: 's1', type: 'system', timestamp: '2026-10-11T00:03:00.000Z', content: 'sys' } as unknown as ChatMessage,
    ]
    await syncSessionToShared('s1', 'conv-1', msgs)
    expect(appended.map((e) => e.role)).toEqual(['user', 'assistant', 'system', 'system'])
  })

  it('content 为完整 ChatMessage JSON 序列化（可还原）', async () => {
    await syncSessionToShared('s1', 'conv-1', [userMsg('u1', '你好')])
    const content = appended[0].content as Record<string, unknown>
    expect(content.type).toBe('user')
    expect(content.content).toBe('你好')
    expect(content.timestamp).toBe('2026-10-11T00:00:00.000Z')
  })

  it('deviceId 注入本端标识', async () => {
    await syncSessionToShared('s1', 'conv-1', [userMsg('u1', 'hi')])
    expect(appended[0].deviceId).toBe(getDeviceId())
  })

  it('幂等水位：同 id 不重复写', async () => {
    const msgs = [userMsg('u1', '你好')]
    await syncSessionToShared('s1', 'conv-1', msgs)
    expect(appended.length).toBe(1)
    // 再次同步同一 id（模拟 finishMessage 二次触发）→ 不重复写
    await syncSessionToShared('s1', 'conv-1', msgs)
    expect(appended.length).toBe(1)
  })

  it('增量：新增消息追加写、旧消息跳过', async () => {
    await syncSessionToShared('s1', 'conv-1', [userMsg('u1', '你好'), assistantMsg('a1')])
    expect(appended.length).toBe(2)
    // 新加 assistant 回复 a2，再同步 → 只补 a2
    await syncSessionToShared('s1', 'conv-1', [userMsg('u1', '你好'), assistantMsg('a1'), assistantMsg('a2')])
    expect(appended.length).toBe(3)
    expect(appended[2].id).toBe('a2')
  })

  it('失败不抛（fire-and-forget）：append reject → 返回 false 不异常', async () => {
    // 让下一次 message_append 拒绝（模拟命令错误）；mockRejectedValueOnce 一次性，
    // 下次调用自动恢复默认伪后端，不影响后续测试。
    vi.mocked(invoke).mockRejectedValueOnce(new Error('backend down'))
    await expect(syncSessionToShared('s1', 'conv-1', [userMsg('u1', 'hi')])).resolves.toBe(false)
    expect(appended.length).toBe(0) // 失败未写入
  })
})

describe('syncStreamingMessage（Phase 4 流式增量）', () => {
  beforeEach(() => {
    appended.length = 0
    appendedIds.clear()
    revised.length = 0
    versionByMessage.clear()
    clearSyncedWatermark('s1')
  })

  afterEach(() => {
    clearSyncedWatermark('s1')
  })

  it('conversationId 为 null → 跳过（流式开始前无后端会话）', async () => {
    await syncStreamingMessage('s1', null, streamingAssistantMsg('a1', '首段'))
    expect(appended.length).toBe(0)
    expect(revised.length).toBe(0)
  })

  it('非 assistant 消息 → 跳过（user 由 syncSessionToShared 负责）', async () => {
    await syncStreamingMessage('s1', 'conv-1', userMsg('u1', '你好'))
    expect(appended.length).toBe(0)
    expect(revised.length).toBe(0)
  })

  it('首次 → append v1（创建并广播），后续 → revise 新版本（流式增量）', async () => {
    // 首次 tick：append
    await syncStreamingMessage('s1', 'conv-1', streamingAssistantMsg('a1', '第'))
    expect(appended.length).toBe(1)
    expect(appended[0].id).toBe('a1')
    expect(appended[0].conversationId).toBe('conv-1')
    expect((appended[0].content as Record<string, unknown>).isStreaming).toBe(true)

    // 第二个 tick：revise（append 不动）
    await syncStreamingMessage('s1', 'conv-1', streamingAssistantMsg('a1', '第一段'))
    expect(appended.length).toBe(1) // 不重复 append
    expect(revised.length).toBe(1)
    expect(revised[0].id).toBe('a1')
    expect((revised[0].content as Record<string, unknown>).blocks[0].content).toBe('第一段')

    // 第三个 tick：再 revise
    await syncStreamingMessage('s1', 'conv-1', streamingAssistantMsg('a1', '第一段内容'))
    expect(revised.length).toBe(2)
    expect((revised[1].content as Record<string, unknown>).blocks[0].content).toBe('第一段内容')
  })

  it('失败不抛（fire-and-forget）：revise reject → 不抛异常，水位不变', async () => {
    await syncStreamingMessage('s1', 'conv-1', streamingAssistantMsg('a1', '首段'))
    expect(appended.length).toBe(1)
    // 让下一次 revise 拒绝 → 不抛（fire-and-forget 语义）
    vi.mocked(invoke).mockRejectedValueOnce(new Error('backend down'))
    await expect(
      syncStreamingMessage('s1', 'conv-1', streamingAssistantMsg('a1', '第二段')),
    ).resolves.toBeUndefined()
    expect(revised.length).toBe(0) // 该次 revise 失败未计入
  })
})