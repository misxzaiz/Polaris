import { describe, expect, it, vi } from 'vitest'
import {
  PluginEntryShapeError,
  PluginLoadError,
  loadPluginPanel,
} from './loader'
import { HOST_API_VERSION, PluginApiVersionMismatchError } from './version'

describe('loadPluginPanel', () => {
  it('returns the default-exported component on happy path', async () => {
    const Panel = () => null
    const dynamicImport = vi.fn().mockResolvedValue({ default: Panel })

    const result = await loadPluginPanel({
      pluginId: 'demo',
      entryUrl: 'inline://demo',
      dynamicImport,
    })

    expect(result).toBe(Panel)
    expect(dynamicImport).toHaveBeenCalledWith('inline://demo')
  })

  it('enforces requiredApiVersion before importing', async () => {
    const dynamicImport = vi.fn()

    await expect(
      loadPluginPanel({
        pluginId: 'demo',
        entryUrl: 'inline://demo',
        requiredApiVersion: '99.0.0',
        dynamicImport,
      })
    ).rejects.toBeInstanceOf(PluginApiVersionMismatchError)

    expect(dynamicImport).not.toHaveBeenCalled()
  })

  it('admits satisfied version ranges and proceeds to load', async () => {
    const Panel = () => null
    const dynamicImport = vi.fn().mockResolvedValue({ default: Panel })

    const result = await loadPluginPanel({
      pluginId: 'demo',
      entryUrl: 'inline://demo',
      requiredApiVersion: '*',
      dynamicImport,
    })

    expect(result).toBe(Panel)
  })

  it('wraps import errors in PluginLoadError', async () => {
    const cause = new Error('network down')
    const dynamicImport = vi.fn().mockRejectedValue(cause)

    try {
      await loadPluginPanel({
        pluginId: 'demo',
        entryUrl: 'inline://demo',
        dynamicImport,
      })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PluginLoadError)
      const typed = err as PluginLoadError
      expect(typed.pluginId).toBe('demo')
      expect(typed.entryUrl).toBe('inline://demo')
      expect(typed.cause).toBe(cause)
    }
  })

  it('rejects modules without default export', async () => {
    const dynamicImport = vi.fn().mockResolvedValue({ named: () => null })
    await expect(
      loadPluginPanel({
        pluginId: 'demo',
        entryUrl: 'inline://demo',
        dynamicImport,
      })
    ).rejects.toBeInstanceOf(PluginEntryShapeError)
  })

  it('rejects when default export is not a function', async () => {
    const dynamicImport = vi.fn().mockResolvedValue({ default: { not: 'a fn' } })
    await expect(
      loadPluginPanel({
        pluginId: 'demo',
        entryUrl: 'inline://demo',
        dynamicImport,
      })
    ).rejects.toBeInstanceOf(PluginEntryShapeError)
  })

  it('rejects when module resolves to a non-object', async () => {
    const dynamicImport = vi.fn().mockResolvedValue(null)
    await expect(
      loadPluginPanel({
        pluginId: 'demo',
        entryUrl: 'inline://demo',
        dynamicImport,
      })
    ).rejects.toBeInstanceOf(PluginEntryShapeError)
  })
})

describe('loadPluginPanel — integration with HOST_API_VERSION', () => {
  it('caret range matching current host version succeeds', async () => {
    const Panel = () => null
    const dynamicImport = vi.fn().mockResolvedValue({ default: Panel })

    const result = await loadPluginPanel({
      pluginId: 'demo',
      entryUrl: 'inline://demo',
      requiredApiVersion: `^${HOST_API_VERSION}`,
      dynamicImport,
    })

    expect(result).toBe(Panel)
  })
})
