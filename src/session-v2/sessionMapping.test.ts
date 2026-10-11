/**
 * sessionMapping 单测 — S5 三轨映射命令封装
 *
 * 覆盖：
 * 1. resolveSessionMapping：按 sessionId 查映射（存在返回对象、不存在返回 null、命令失败返回 null）；
 * 2. findMappingByConversation：按 conversationId 反查；
 * 3. upsertSessionMapping：写入映射（成功静默、失败仅 log 不抛）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  resolveSessionMapping,
  findMappingByConversation,
  upsertSessionMapping,
  type SessionMapping,
} from './sessionMapping'
import { invoke } from '@/services/transport'

vi.mock('@/services/transport', () => ({
  invoke: vi.fn(),
}))

const okMapping: SessionMapping = {
  sessionId: 's1',
  conversationId: 'conv-1',
  externalId: 'ext-1',
  workspaceKey: '__free__',
  archived: false,
  createdAt: 1728600000000,
}

describe('sessionMapping', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('resolveSessionMapping: 命中返回映射', async () => {
    vi.mocked(invoke).mockResolvedValue(okMapping)
    const result = await resolveSessionMapping('s1')
    expect(result).toEqual(okMapping)
    expect(invoke).toHaveBeenCalledWith('session_mapping_resolve', { sessionId: 's1' })
  })

  it('resolveSessionMapping: 不存在返回 null', async () => {
    vi.mocked(invoke).mockResolvedValue(null)
    expect(await resolveSessionMapping('nope')).toBeNull()
  })

  it('resolveSessionMapping: 命令失败返回 null 不抛', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('backend down'))
    await expect(resolveSessionMapping('s1')).resolves.toBeNull()
  })

  it('findMappingByConversation: 命中返回映射', async () => {
    vi.mocked(invoke).mockResolvedValue(okMapping)
    const result = await findMappingByConversation('conv-1')
    expect(result).toEqual(okMapping)
    expect(invoke).toHaveBeenCalledWith('session_mapping_find_by_conversation', {
      conversationId: 'conv-1',
    })
  })

  it('findMappingByConversation: 失败返回 null 不抛', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('down'))
    await expect(findMappingByConversation('conv-1')).resolves.toBeNull()
  })

  it('upsertSessionMapping: 成功静默', async () => {
    vi.mocked(invoke).mockResolvedValue(okMapping)
    await expect(
      upsertSessionMapping('s1', 'conv-1', '__free__', 'ext-1'),
    ).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('session_mapping_upsert', {
      sessionId: 's1',
      conversationId: 'conv-1',
      externalId: 'ext-1',
      workspaceKey: '__free__',
    })
  })

  it('upsertSessionMapping: 失败仅 log 不抛', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('down'))
    await expect(upsertSessionMapping('s1', 'conv-1', '__free__')).resolves.toBeUndefined()
  })
})