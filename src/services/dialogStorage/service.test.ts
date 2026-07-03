/**
 * dialogStorageService 单元测试
 *
 * 使用 localStorage backend（jsdom 环境无 OPFS，自动降级）。
 * 重点验证：保存/读取往返、幂等（重复保存不重复累积）、分页排序、删除。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { dialogStorageService } from './service'
import { __setDialogBackendForTest, type DialogBackend, type DialogMetaEntry } from './dialogBackend'
import type { ChatMessage, UserChatMessage, AssistantChatMessage } from '@/types'

/**
 * 确定性内存后端：解耦测试与运行环境探测（isTauri/OPFS 在测试环境不可靠），
 * 同时覆盖高效列举路径 listMeta（仅取每个文件首行）。
 */
class InMemoryBackend implements DialogBackend {
  readonly kind = 'localstorage' as const
  private files = new Map<string, string>()

  async writeFile(name: string, content: string): Promise<void> {
    this.files.set(name, content)
  }
  async readFile(name: string): Promise<string | null> {
    return this.files.has(name) ? this.files.get(name)! : null
  }
  async listFiles(): Promise<string[]> {
    return [...this.files.keys()]
  }
  async listMeta(): Promise<DialogMetaEntry[]> {
    const out: DialogMetaEntry[] = []
    for (const [name, content] of this.files) {
      const nl = content.indexOf('\n')
      const metaLine = (nl === -1 ? content : content.slice(0, nl)).trim()
      if (metaLine) out.push({ name, metaLine })
    }
    return out
  }
  async deleteFile(name: string): Promise<void> {
    this.files.delete(name)
  }
}

function userMsg(id: string, content: string): UserChatMessage {
  return { id, type: 'user', timestamp: '2026-06-16T00:00:00.000Z', content }
}

function assistantMsg(id: string, text: string): AssistantChatMessage {
  return {
    id,
    type: 'assistant',
    timestamp: '2026-06-16T00:00:02.000Z',
    blocks: [{ type: 'text', content: text }],
    engineId: 'claude-code',
  }
}

beforeEach(() => {
  localStorage.clear()
  // 注入确定性内存后端，避免依赖运行环境探测（isTauri/OPFS 在测试中不稳定）
  __setDialogBackendForTest(new InMemoryBackend())
})

describe('dialogStorageService - 保存与读取', () => {
  it('saveConversation 后能读回完整消息（顺序一致）', async () => {
    const messages: ChatMessage[] = [
      userMsg('u1', '你好'),
      assistantMsg('a1', '你好！'),
      userMsg('u2', '再见'),
    ]
    await dialogStorageService.saveConversation({
      externalId: 'conv-1',
      engineId: 'claude-code',
      title: '会话1',
      messages,
    })

    const record = await dialogStorageService.getConversation('conv-1')
    expect(record).not.toBeNull()
    expect(record!.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
    expect(record!.meta.title).toBe('会话1')

    const onlyMessages = await dialogStorageService.getConversationMessages('conv-1')
    expect(onlyMessages).toEqual(messages)
  })

  it('不存在的会话返回 null / 空数组', async () => {
    expect(await dialogStorageService.getConversation('nope')).toBeNull()
    expect(await dialogStorageService.getConversationMessages('nope')).toEqual([])
    expect(await dialogStorageService.hasConversation('nope')).toBe(false)
  })

  it('空消息列表不写入', async () => {
    await dialogStorageService.saveConversation({
      externalId: 'empty',
      engineId: 'claude-code',
      title: 'x',
      messages: [],
    })
    expect(await dialogStorageService.hasConversation('empty')).toBe(false)
  })
})

describe('dialogStorageService - 幂等（根治重复累积）', () => {
  it('重复保存同一会话不会累积重复消息', async () => {
    const messages: ChatMessage[] = [userMsg('u1', 'A'), assistantMsg('a1', 'B')]

    // 保存 3 次
    for (let i = 0; i < 3; i++) {
      await dialogStorageService.saveConversation({
        externalId: 'conv-dup',
        engineId: 'claude-code',
        title: '会话',
        messages,
      })
    }

    const record = await dialogStorageService.getConversation('conv-dup')
    expect(record!.messages.length).toBe(2) // 不是 6
    expect(record!.meta.messageCount).toBe(2)

    const list = await dialogStorageService.listConversations()
    expect(list.total).toBe(1) // 只有一个会话
  })

  it('追加消息后重新保存反映最新全量', async () => {
    await dialogStorageService.saveConversation({
      externalId: 'conv-grow',
      engineId: 'claude-code',
      title: '会话',
      messages: [userMsg('u1', 'A')],
    })
    await dialogStorageService.saveConversation({
      externalId: 'conv-grow',
      engineId: 'claude-code',
      title: '会话',
      messages: [userMsg('u1', 'A'), assistantMsg('a1', 'B'), userMsg('u2', 'C')],
    })

    const record = await dialogStorageService.getConversation('conv-grow')
    expect(record!.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
  })

  it('重复保存保留 createdAt，更新 updatedAt', async () => {
    await dialogStorageService.saveConversation({
      externalId: 'conv-time',
      engineId: 'claude-code',
      title: '会话',
      messages: [userMsg('u1', 'A')],
    })
    const first = await dialogStorageService.getConversation('conv-time')
    const createdAt = first!.meta.createdAt

    // 再次保存
    await dialogStorageService.saveConversation({
      externalId: 'conv-time',
      engineId: 'claude-code',
      title: '会话改名',
      messages: [userMsg('u1', 'A'), assistantMsg('a1', 'B')],
    })
    const second = await dialogStorageService.getConversation('conv-time')

    expect(second!.meta.createdAt).toBe(createdAt) // createdAt 不变
    expect(second!.meta.title).toBe('会话改名') // 标题更新
  })
})

describe('dialogStorageService - 列表分页', () => {
  beforeEach(async () => {
    // 造 5 个会话，updatedAt 通过保存顺序区分（buildMeta 用当前时间，顺序递增）。
    // 两次保存之间留 2ms 间隔，确保 updatedAt 毫秒级严格递增，避免稳定排序保留文件序导致顺序错乱。
    for (let i = 1; i <= 5; i++) {
      await dialogStorageService.saveConversation({
        externalId: `conv-${i}`,
        engineId: i % 2 === 0 ? 'codex' : 'claude-code',
        title: `会话${i}`,
        messages: [userMsg(`u${i}`, `消息${i}`)],
      })
      await new Promise((r) => setTimeout(r, 2))
    }
  })

  it('listConversations 返回全部并分页', async () => {
    const page1 = await dialogStorageService.listConversations({ page: 1, pageSize: 2 })
    expect(page1.total).toBe(5)
    expect(page1.items.length).toBe(2)
    expect(page1.totalPages).toBe(3)
    expect(page1.hasMore).toBe(true)

    const page3 = await dialogStorageService.listConversations({ page: 3, pageSize: 2 })
    expect(page3.items.length).toBe(1)
    expect(page3.hasMore).toBe(false)
  })

  it('默认按 updatedAt 降序（最新在前）', async () => {
    const list = await dialogStorageService.listConversations({ page: 1, pageSize: 10 })
    const ids = list.items.map((m) => m.externalId)
    // 最后保存的 conv-5 应在最前
    expect(ids[0]).toBe('conv-5')
  })
})

describe('dialogStorageService - 删除', () => {
  it('deleteConversation 移除会话', async () => {
    await dialogStorageService.saveConversation({
      externalId: 'conv-del',
      engineId: 'claude-code',
      title: '待删除',
      messages: [userMsg('u1', 'A')],
    })
    expect(await dialogStorageService.hasConversation('conv-del')).toBe(true)

    await dialogStorageService.deleteConversation('conv-del')
    expect(await dialogStorageService.hasConversation('conv-del')).toBe(false)
    expect(await dialogStorageService.getConversation('conv-del')).toBeNull()
  })

  it('删除其中一个不影响其他会话', async () => {
    await dialogStorageService.saveConversation({
      externalId: 'keep',
      engineId: 'claude-code',
      title: '保留',
      messages: [userMsg('u1', 'A')],
    })
    await dialogStorageService.saveConversation({
      externalId: 'remove',
      engineId: 'claude-code',
      title: '删除',
      messages: [userMsg('u2', 'B')],
    })

    await dialogStorageService.deleteConversation('remove')

    expect(await dialogStorageService.hasConversation('keep')).toBe(true)
    expect(await dialogStorageService.hasConversation('remove')).toBe(false)
  })
})
