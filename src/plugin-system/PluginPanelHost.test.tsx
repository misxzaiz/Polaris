/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import {
  __resetPluginRuntimeForTests,
  installPluginRuntime,
} from './runtime'
import {
  PluginPanelHost,
  __resetPluginPanelHostCacheForTests,
} from './PluginPanelHost'
import type { PolarisPluginApi } from './runtime'

// Stub a tiny plugin component so the loader returns something we can assert.
function makeFakeModule(componentText: string) {
  const Component = ({ api }: { api: PolarisPluginApi }) =>
    api.react.createElement(
      'div',
      { 'data-testid': 'plugin-output' },
      `${componentText}::${api.pluginId}`
    )
  return { default: Component }
}

beforeEach(() => {
  __resetPluginRuntimeForTests()
  __resetPluginPanelHostCacheForTests()
  installPluginRuntime()
})

afterEach(() => {
  __resetPluginRuntimeForTests()
  __resetPluginPanelHostCacheForTests()
})

describe('PluginPanelHost', () => {
  it('loads, mints api, and renders the plugin component', async () => {
    // Inject the loader's dynamicImport by monkey-patching window.import?
    // Easier: pre-seed the React.lazy cache by stubbing `loadPluginPanel` via
    // vi.mock — but that's heavy. Instead, since `getOrCreateLazyComponent`
    // calls `loadPluginPanel` with the default dynamic import, we can spy on
    // it at the module level.

    // Use the public `loadPluginPanel` directly to populate the cache deterministically.
    const { loadPluginPanel } = await import('./runtime')
    const fake = makeFakeModule('hello')
    const dynamicImport = vi.fn().mockResolvedValue(fake)
    // First call seeds the cache via React.lazy — we have to go through the
    // component so the lazy wrapper triggers. Provide the stub by routing
    // through the component's URL with the loader's `dynamicImport` override.
    //
    // Since PluginPanelHost calls loadPluginPanel(...) without an override,
    // we need a different angle: spy on the module's `loadPluginPanel` export.
    // To keep this test simple and self-contained, we use vi.spyOn on the
    // runtime barrel.
    const runtime = await import('./runtime')
    const spy = vi
      .spyOn(runtime, 'loadPluginPanel')
      .mockImplementation(async (opts) => {
        await dynamicImport(opts.entryUrl)
        return fake.default
      })
    // No-op assertion to satisfy ESLint about unused variable: loadPluginPanel.
    expect(typeof loadPluginPanel).toBe('function')

    render(
      <PluginPanelHost
        pluginId="demo.plugin"
        entryUrl="inline://demo"
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('plugin-output')).toBeTruthy()
    })
    expect(screen.getByTestId('plugin-output').textContent).toBe(
      'hello::demo.plugin'
    )
    expect(spy).toHaveBeenCalledWith({
      pluginId: 'demo.plugin',
      entryUrl: 'inline://demo',
      requiredApiVersion: undefined,
    })
  })

  it('renders error block when the plugin module fails to load', async () => {
    const runtime = await import('./runtime')
    vi.spyOn(runtime, 'loadPluginPanel').mockRejectedValue(
      new Error('boom: network down')
    )

    render(
      <PluginPanelHost
        pluginId="demo.plugin"
        entryUrl="inline://broken"
      />
    )

    await waitFor(() => {
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toContain('boom: network down')
    })
  })

  it('renders fallback while loading', async () => {
    const runtime = await import('./runtime')
    // Make loadPluginPanel hang to keep us in fallback.
    vi.spyOn(runtime, 'loadPluginPanel').mockImplementation(
      () => new Promise(() => {})
    )

    render(
      <PluginPanelHost
        pluginId="demo.plugin"
        entryUrl="inline://slow"
        fallback={<div data-testid="custom-fallback">spinner</div>}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('custom-fallback')).toBeTruthy()
    })
  })

  it('uses custom renderError when provided', async () => {
    const runtime = await import('./runtime')
    vi.spyOn(runtime, 'loadPluginPanel').mockRejectedValue(
      new Error('shape error')
    )

    render(
      <PluginPanelHost
        pluginId="demo.plugin"
        entryUrl="inline://wrong"
        renderError={(err) => (
          <div data-testid="custom-error">CUSTOM:{err.message}</div>
        )}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('custom-error').textContent).toBe(
        'CUSTOM:shape error'
      )
    })
  })

  it('survives unmount/remount cycles with the same entry', async () => {
    const runtime = await import('./runtime')
    const fake = makeFakeModule('cached')
    vi.spyOn(runtime, 'loadPluginPanel').mockResolvedValue(fake.default)

    const { unmount: unmount1 } = render(
      <PluginPanelHost pluginId="demo" entryUrl="inline://x" />
    )
    await waitFor(() => screen.getByTestId('plugin-output'))
    expect(screen.getByTestId('plugin-output').textContent).toBe(
      'cached::demo'
    )
    unmount1()

    const { unmount: unmount2 } = render(
      <PluginPanelHost pluginId="demo" entryUrl="inline://x" />
    )
    await waitFor(() => screen.getByTestId('plugin-output'))
    expect(screen.getByTestId('plugin-output').textContent).toBe(
      'cached::demo'
    )
    unmount2()
  })
})
