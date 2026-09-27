/**
 * V2MessageLog 影子验证 — 阶段 1b
 *
 * 目标：验证 V2MessageLog（调后端命令）的行为与 InMemoryMessageLog（案例 1 已
 * 验证的基准）一致，且 invoke 参数契约正确（camelCase ↔ 后端命令对齐）。
 *
 * 验证方式：mock 统一 transport 的 `invoke`，用一个内存"伪后端"模拟后端
 * message_* 命令的 SQLite 语义（幂等 INSERT OR IGNORE / 修订链 / timestamp 升序）。
 * 跑一遍案例 1 的核心矩阵，确认 V2MessageLog 只是换了传输层、语义零变化。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { V2MessageLog } from '../core/v2-message-log'
import type { MessageEntry } from '../core/types'

// ============================================================================
// 伪后端：模拟后端 SQLite 的 append-only 语义（INSERT OR IGNORE 幂等/修订链）
// ============================================================================

class FakeBackend {
  /** id+version → entry（INSERT OR IGNORE 幂等） */
  private rows = new Map<string, MessageEntry>()

  handle(command: string, args: Record<string, unknown>): unknown {
    switch (command) {
      case 'message_append': {
        const entry = args as unknown as MessageEntry
        const key = `${entry.id}#${entry.version}`
        if (this.rows.has(key)) return false
        this.rows.set(key, entry)
        return true
      }
      case 'message_revise': {
        const id = args.id as string
        const content = args.content as Record<string, unknown>
        const versions = [...this.rows.values()]
          .filter(e => e.id === id)
          .sort((a, b) => a.version - b.version)
        if (versions.length === 0) throw new Error(`Message not found: ${id}`)
        const latest = versions[versions.length - 1]
        const newVersion = latest.version + 1
        this.rows.set(`${id}#${newVersion}`, {
          ...latest,
          content,
          version: newVersion,
          parentVersion: latest.version,
        })
        return newVersion
      }
      case 'message_read': {
        const conversationId = args.conversationId as string
        const afterTimestamp = args.afterTimestamp as number | undefined
        const limit = args.limit as number | undefined
        const latestByMessage = new Map<string, MessageEntry>()
        for (const e of this.rows.values()) {
          if (e.conversationId !== conversationId) continue
          const cur = latestByMessage.get(e.id)
          if (!cur || e.version > cur.version) latestByMessage.set(e.id, e)
        }
        let list = [...latestByMessage.values()].sort((a, b) => a.timestamp - b.timestamp)
        if (afterTimestamp != null) list = list.filter(e => e.timestamp > afterTimestamp)
        if (limit != null) list = list.slice(0, limit)
        return list
      }
      case 'message_read_history': {
        const id = args.id as string
        return [...this.rows.values()]
          .filter(e => e.id === id)
          .sort((a, b) => a.version - b.version)
      }
      case 'message_get_latest': {
        const id = args.id as string
        const versions = [...this.rows.values()]
          .filter(e => e.id === id)
          .sort((a, b) => a.version - b.version)
        return versions.length > 0 ? versions[versions.length - 1] : null
      }
      case 'message_delete_by_conversation': {
        const conversationId = args.conversationId as string
        for (const [key, e] of this.rows) {
          if (e.conversationId === conversationId) this.rows.delete(key)
        }
        return null
      }
      default:
        throw new Error(`Unknown command: ${command}`)
    }
  }
}

// ============================================================================
// mock 统一 transport（顶层 hoisted）：V2MessageLog 只依赖 invoke 命令契约
// ============================================================================

/** 测试可替换的命令处理器（beforeEach 注册 FakeBackend） */
const commandHandlers = new Map<string, (args: Record<string, unknown>) => unknown>()

vi.mock('@/services/transport', () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const handler = commandHandlers.get(cmd)
    if (!handler) return Promise.reject(new Error(`Unknown command: ${cmd}`))
    return Promise.resolve(handler(args ?? {}))
  }),
}))

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

describe('V2MessageLog 影子验证（后端 SQLite append-only）', () => {
  let log: V2MessageLog
  let backend: FakeBackend
  const CONV_ID = 'conv-v2-001'

  beforeEach(() => {
    backend = new FakeBackend()
    // 把伪后端注册为全部 6 个命令的处理器
    for (const cmd of [
      'message_append',
      'message_revise',
      'message_read',
      'message_read_history',
      'message_get_latest',
      'message_delete_by_conversation',
    ]) {
      commandHandlers.set(cmd, (args) => backend.handle(cmd, args))
    }
    log = new V2MessageLog()
  })

  afterEach(() => {
    commandHandlers.clear()
    vi.clearAllMocks()
  })

  it('单设备追加 100 条 → 读取到 100 条', async () => {
    const promises: Promise<boolean>[] = []
    for (let i = 0; i < 100; i++) {
      promises.push(log.append(makeEntry(`M${i}`, CONV_ID, 'user', 1000 + i, 'device-A')))
    }
    await Promise.all(promises)
    const messages = await log.read(CONV_ID)
    expect(messages.length).toBe(100)
  })

  it('消息按 timestamp 升序排列（乱序追加）', async () => {
    await log.append(makeEntry('M3', CONV_ID, 'user', 3000, 'A'))
    await log.append(makeEntry('M1', CONV_ID, 'user', 1000, 'A'))
    await log.append(makeEntry('M2', CONV_ID, 'user', 2000, 'A'))
    const messages = await log.read(CONV_ID)
    expect(messages.map(m => m.id)).toEqual(['M1', 'M2', 'M3'])
  })

  it('两设备并发各写 100 条 → 最终 200 条无重复', async () => {
    const promises: Promise<boolean>[] = []
    for (let i = 0; i < 100; i++) {
      promises.push(log.append(makeEntry(`A${i}`, CONV_ID, 'user', 1000 + i, 'device-A')))
    }
    for (let i = 0; i < 100; i++) {
      promises.push(log.append(makeEntry(`B${i}`, CONV_ID, 'assistant', 1000 + i, 'device-B')))
    }
    await Promise.all(promises)
    const messages = await log.read(CONV_ID)
    expect(messages.length).toBe(200)
    expect(new Set(messages.map(m => m.id)).size).toBe(200)
  })

  it('相同 ID 并发追加 → 幂等去重只保留 1 条', async () => {
    const shared = makeEntry('shared-001', CONV_ID, 'user', 1000, 'device-A', { text: 'hello' })
    const dup = makeEntry('shared-001', CONV_ID, 'user', 1000, 'device-B', { text: 'hello' })
    const [r1, r2] = await Promise.all([log.append(shared), log.append(dup)])
    expect(r1 === true || r2 === true).toBe(true)
    expect(r1 === false || r2 === false).toBe(true)
    const messages = await log.read(CONV_ID)
    expect(messages.length).toBe(1)
  })

  it('相同 ID 不同内容并发 → 先到先得只保留 1 条', async () => {
    await Promise.all([
      log.append(makeEntry('conflict-001', CONV_ID, 'user', 1000, 'A', { text: 'from A' })),
      log.append(makeEntry('conflict-001', CONV_ID, 'user', 1000, 'B', { text: 'from B' })),
    ])
    const messages = await log.read(CONV_ID)
    expect(messages.length).toBe(1)
    expect(['from A', 'from B']).toContain(messages[0].content.text)
  })

  it('不同会话互不干扰', async () => {
    await log.append(makeEntry('M1', 'conv-a', 'user', 1000, 'A'))
    await log.append(makeEntry('M2', 'conv-b', 'user', 2000, 'A'))
    expect((await log.read('conv-a')).length).toBe(1)
    expect((await log.read('conv-b')).length).toBe(1)
    expect((await log.read('conv-none')).length).toBe(0)
  })

  it('revise 追加新版本旧版本保留，read 返回最新', async () => {
    await log.append(makeEntry('M1', CONV_ID, 'assistant', 1000, 'A', { text: 'v1' }))
    const v2 = await log.revise('M1', { text: 'v2' })
    expect(v2).toBe(2)
    const v3 = await log.revise('M1', { text: 'v3' })
    expect(v3).toBe(3)

    const history = await log.readHistory('M1')
    expect(history.length).toBe(3)
    expect(history.map(h => h.version)).toEqual([1, 2, 3])

    const latest = await log.getLatest('M1')
    expect(latest?.version).toBe(3)
    expect(latest?.content.text).toBe('v3')

    const messages = await log.read(CONV_ID)
    expect(messages.length).toBe(1)
    expect(messages[0].content.text).toBe('v3')
  })

  it('read 支持 afterTimestamp 增量', async () => {
    for (const [i, ts] of [1000, 2000, 3000, 4000].entries()) {
      await log.append(makeEntry(`M${i + 1}`, CONV_ID, 'user', ts, 'A'))
    }
    const after = await log.read(CONV_ID, { afterTimestamp: 2000 })
    expect(after.map(m => m.timestamp)).toEqual([3000, 4000])
  })

  it('read 支持 limit 分页', async () => {
    for (const [i, ts] of [1000, 2000, 3000, 4000].entries()) {
      await log.append(makeEntry(`M${i + 1}`, CONV_ID, 'user', ts, 'A'))
    }
    const limited = await log.read(CONV_ID, { limit: 2 })
    expect(limited.map(m => m.timestamp)).toEqual([1000, 2000])
  })

  it('deleteByConversation 只删目标会话', async () => {
    await log.append(makeEntry('M1', 'conv-a', 'user', 1000, 'A'))
    await log.append(makeEntry('M2', 'conv-b', 'user', 2000, 'A'))
    await log.deleteByConversation('conv-a')
    expect((await log.read('conv-a')).length).toBe(0)
    expect((await log.read('conv-b')).length).toBe(1)
  })

  it('revise 不存在的消息 → 抛错', async () => {
    await expect(log.revise('ghost', { text: 'x' })).rejects.toThrow('Message not found: ghost')
  })
})
