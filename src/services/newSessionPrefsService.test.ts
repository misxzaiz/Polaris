/**
 * newSessionPrefsService 测试
 *
 * 覆盖：cap.kv 读写路径（router_dispatch 调用形态）、
 * 按引擎分层 key、读侧解析失败降级（返回 null 不抛错）、
 * 写入侧结构归一化（official 不携带 Profile id）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@/services/transport', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
  currentMode: 'tauri',
}))

import {
  readNewSessionPrefs,
  persistNewSessionPrefs,
  newSessionPrefsKey,
  normalizeNewSessionPrefs,
  type NewSessionPrefs,
} from '@/services/newSessionPrefsService'

function kvOk(result: Record<string, unknown>) {
  return { ok: true, msgId: 'm', error: null, trace: '', result }
}

describe('newSessionPrefsService', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('key 按引擎分层，避免与其它 kv 使用方冲突', () => {
    expect(newSessionPrefsKey('claude-code')).toBe('new-session-prefs:claude-code')
    expect(newSessionPrefsKey('simple-ai')).toBe('new-session-prefs:simple-ai')
    expect(newSessionPrefsKey('claude-code')).not.toBe(newSessionPrefsKey('simple-ai'))
  })

  it('read：合法记录原样返回', async () => {
    invokeMock.mockResolvedValue(kvOk({
      value: { providerMode: 'profile', modelProfileId: 'profile_abc', model: 'deepseek-v4' },
    }))
    const prefs = await readNewSessionPrefs('claude-code')
    expect(prefs).toEqual({ providerMode: 'profile', modelProfileId: 'profile_abc', model: 'deepseek-v4' })
    // cap.kv get 调用形态
    expect(invokeMock).toHaveBeenCalledWith('router_dispatch', {
      req: {
        target: 'cap.kv',
        payload: { action: 'get', key: 'new-session-prefs:claude-code' },
      },
    })
  })

  it('read：official 记录强制清空 Profile id（防残留穿透）', async () => {
    invokeMock.mockResolvedValue(kvOk({
      value: { providerMode: 'official', modelProfileId: 'stale-profile', model: '' },
    }))
    const prefs = await readNewSessionPrefs('claude-code')
    expect(prefs).toEqual({ providerMode: 'official', modelProfileId: '', model: '' })
  })

  it('read：无记录（value null）返回 null，调用方降级', async () => {
    invokeMock.mockResolvedValue(kvOk({ value: null }))
    expect(await readNewSessionPrefs('claude-code')).toBeNull()
  })

  it('read：结构非法（缺 providerMode / 非法模式）返回 null', async () => {
    invokeMock.mockResolvedValue(kvOk({ value: { model: 'x' } }))
    expect(await readNewSessionPrefs('claude-code')).toBeNull()

    invokeMock.mockResolvedValue(kvOk({ value: { providerMode: 'group', modelProfileId: 'p' } }))
    expect(await readNewSessionPrefs('claude-code')).toBeNull()
  })

  it('read：调用失败静默降级为 null，不抛错', async () => {
    invokeMock.mockRejectedValue(new Error('cap.kv 不可用'))
    expect(await readNewSessionPrefs('claude-code')).toBeNull()
  })

  it('persist：写入该引擎 key，走 cap.kv set', async () => {
    invokeMock.mockResolvedValue(kvOk({ id: 'new-session-prefs:claude-code' }))
    await persistNewSessionPrefs('claude-code', {
      providerMode: 'profile',
      modelProfileId: 'profile_abc',
      model: 'opus',
    })
    expect(invokeMock).toHaveBeenCalledWith('router_dispatch', {
      req: {
        target: 'cap.kv',
        payload: {
          action: 'set',
          key: 'new-session-prefs:claude-code',
          value: { providerMode: 'profile', modelProfileId: 'profile_abc', model: 'opus' },
        },
      },
    })
  })

  it('persist：official 写入时归一化清空 Profile id', async () => {
    invokeMock.mockResolvedValue(kvOk({ id: 'k' }))
    await persistNewSessionPrefs('claude-code', {
      providerMode: 'official',
      modelProfileId: 'ignored-profile',
      model: '',
    } as NewSessionPrefs)
    const [, args] = invokeMock.mock.calls[0]
    const value = (args as { req: { payload: { value: NewSessionPrefs } } }).req.payload.value
    expect(value).toEqual({ providerMode: 'official', modelProfileId: '', model: '' })
  })

  it('persist：调用失败仅静默（不抛错）', async () => {
    invokeMock.mockRejectedValue(new Error('写失败'))
    await expect(
      persistNewSessionPrefs('claude-code', { providerMode: 'profile', modelProfileId: 'p', model: 'm' }),
    ).resolves.toBeUndefined()
  })

  it('normalizeNewSessionPrefs：非对象/空入参返回 null', () => {
    expect(normalizeNewSessionPrefs(null)).toBeNull()
    expect(normalizeNewSessionPrefs('str')).toBeNull()
    expect(normalizeNewSessionPrefs(undefined)).toBeNull()
  })

  it('normalizeNewSessionPrefs：profile 模式无 Profile id 视为无效记忆', () => {
    expect(normalizeNewSessionPrefs({ providerMode: 'profile', modelProfileId: '', model: '' })).toBeNull()
  })
})