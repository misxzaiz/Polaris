import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock the host transport BEFORE importing the module under test so the
// SUT picks up our stubs.
const invokeMock = vi.fn()
const listenMock = vi.fn()

vi.mock('@/services/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  listen: (...args: unknown[]) => listenMock(...args),
}))

import {
  PluginPermissionDeniedError,
  compileAllowlist,
  createPluginTransport,
} from './transport'

afterEach(() => {
  invokeMock.mockReset()
  listenMock.mockReset()
})

describe('compileAllowlist', () => {
  it('deny-all when undefined or empty', () => {
    expect(compileAllowlist(undefined)('foo')).toBe(false)
    expect(compileAllowlist([])('foo')).toBe(false)
  })

  it('exact match', () => {
    const match = compileAllowlist(['knowledge_list_modules'])
    expect(match('knowledge_list_modules')).toBe(true)
    expect(match('knowledge_get_module')).toBe(false)
  })

  it('prefix glob', () => {
    const match = compileAllowlist(['knowledge_*'])
    expect(match('knowledge_list_modules')).toBe(true)
    expect(match('knowledge_anything_else')).toBe(true)
    expect(match('todo_list')).toBe(false)
  })

  it('mixed exact + prefix', () => {
    const match = compileAllowlist(['read_file', 'knowledge_*'])
    expect(match('read_file')).toBe(true)
    expect(match('knowledge_create_module')).toBe(true)
    expect(match('write_file')).toBe(false)
  })

  it('rejects mid-string globs', () => {
    expect(() => compileAllowlist(['know*ledge'])).toThrow(/suffix glob/)
  })

  it('trims whitespace and ignores empty entries', () => {
    const match = compileAllowlist(['  read_file  ', '', '   '])
    expect(match('read_file')).toBe(true)
    expect(match('')).toBe(false)
  })
})

describe('createPluginTransport — invoke', () => {
  it('forwards allowed calls to host transport', async () => {
    invokeMock.mockResolvedValue({ ok: true })
    const transport = createPluginTransport({
      pluginId: 'polaris.knowledge',
      ipcAllowlist: ['knowledge_*'],
    })

    const result = await transport.invoke('knowledge_list_modules', { foo: 1 })

    expect(result).toEqual({ ok: true })
    expect(invokeMock).toHaveBeenCalledWith('knowledge_list_modules', { foo: 1 })
  })

  it('rejects disallowed calls with PluginPermissionDeniedError', async () => {
    const transport = createPluginTransport({
      pluginId: 'polaris.knowledge',
      ipcAllowlist: ['knowledge_*'],
    })

    await expect(transport.invoke('forbidden_command')).rejects.toBeInstanceOf(
      PluginPermissionDeniedError
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('deny-all when no allowlist provided', async () => {
    const transport = createPluginTransport({ pluginId: 'p' })
    await expect(transport.invoke('any_command')).rejects.toBeInstanceOf(
      PluginPermissionDeniedError
    )
  })

  it('error carries plugin id, kind, target', async () => {
    const transport = createPluginTransport({ pluginId: 'demo' })
    try {
      await transport.invoke('blocked_cmd')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PluginPermissionDeniedError)
      const typed = err as PluginPermissionDeniedError
      expect(typed.pluginId).toBe('demo')
      expect(typed.kind).toBe('invoke')
      expect(typed.target).toBe('blocked_cmd')
    }
  })
})

describe('createPluginTransport — listen', () => {
  it('forwards allowed subscriptions and returns unlisten', async () => {
    const unsub = vi.fn()
    listenMock.mockResolvedValue(unsub)
    const transport = createPluginTransport({
      pluginId: 'demo',
      ipcAllowlist: ['evt_*'],
    })

    const handler = vi.fn()
    const returned = await transport.listen('evt_foo', handler)

    expect(listenMock).toHaveBeenCalledWith('evt_foo', handler)
    expect(returned).toBe(unsub)
  })

  it('rejects disallowed events', async () => {
    const transport = createPluginTransport({
      pluginId: 'demo',
      ipcAllowlist: ['evt_*'],
    })
    await expect(transport.listen('other_evt', () => {})).rejects.toBeInstanceOf(
      PluginPermissionDeniedError
    )
  })

  it('event allowlist falls back to ipc allowlist when omitted', async () => {
    listenMock.mockResolvedValue(() => {})
    const transport = createPluginTransport({
      pluginId: 'demo',
      ipcAllowlist: ['shared_*'],
    })
    await expect(
      transport.listen('shared_evt', () => {})
    ).resolves.toBeTypeOf('function')
  })

  it('event allowlist can be set independently of ipc allowlist', async () => {
    listenMock.mockResolvedValue(() => {})
    const transport = createPluginTransport({
      pluginId: 'demo',
      ipcAllowlist: ['only_ipc'],
      eventAllowlist: ['only_event'],
    })

    await expect(transport.listen('only_event', () => {})).resolves.toBeTypeOf('function')
    await expect(transport.listen('only_ipc', () => {})).rejects.toBeInstanceOf(
      PluginPermissionDeniedError
    )
    await expect(transport.invoke('only_event')).rejects.toBeInstanceOf(
      PluginPermissionDeniedError
    )
  })
})
