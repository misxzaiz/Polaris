/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOST_API_VERSION } from './version'
import { PluginPermissionDeniedError } from './transport'
import {
  __resetPluginRuntimeForTests,
  installPluginRuntime,
} from './installer'

beforeEach(() => {
  __resetPluginRuntimeForTests()
})

afterEach(() => {
  __resetPluginRuntimeForTests()
})

describe('installPluginRuntime', () => {
  it('installs window.__POLARIS__ singleton', () => {
    expect(window.__POLARIS__).toBeUndefined()
    installPluginRuntime()
    expect(window.__POLARIS__).toBeDefined()
    expect(window.__POLARIS__?.apiVersion).toBe(HOST_API_VERSION)
  })

  it('is idempotent — second call returns the same runtime', () => {
    const first = installPluginRuntime()
    const second = installPluginRuntime()
    expect(second).toBe(first)
  })

  it('apiVersionSatisfies honors semver ranges', () => {
    const runtime = installPluginRuntime()
    expect(runtime.apiVersionSatisfies('*')).toBe(true)
    expect(runtime.apiVersionSatisfies('99.0.0')).toBe(false)
  })
})

describe('forPlugin — per-plugin API mint', () => {
  it('returns a PolarisPluginApi with the plugin id baked in', () => {
    const runtime = installPluginRuntime()
    const api = runtime.forPlugin('demo.example')

    expect(api.pluginId).toBe('demo.example')
    expect(api.apiVersion).toBe(HOST_API_VERSION)
    expect(typeof api.transport.invoke).toBe('function')
    expect(typeof api.convertFileSrc).toBe('function')
  })

  it('exposes shared React / ReactDOM / i18n singletons', async () => {
    const runtime = installPluginRuntime()
    const api = runtime.forPlugin('demo.example')

    const React = await import('react')
    const ReactDOM = await import('react-dom/client')
    const { default: i18n } = await import('@/i18n')

    expect(api.react).toBe(React)
    expect(api.reactDom).toBe(ReactDOM)
    expect(api.i18n).toBe(i18n)
  })

  it('exposes UI primitives', () => {
    const runtime = installPluginRuntime()
    const api = runtime.forPlugin('demo.example')

    // React components are either functions (function components) or
    // objects (memo / forwardRef-wrapped). Both are valid renderables, so
    // assert presence rather than typeof.
    expect(api.ui.ConfirmDialog).toBeDefined()
    expect(api.ui.ZoomableDiagramContainer).toBeDefined()
    expect(api.ui.CodeMirrorEditor).toBeDefined()
    expect(api.ui.ProgressiveStreamingMarkdown).toBeDefined()
  })

  it('exposes shared store hooks', () => {
    const runtime = installPluginRuntime()
    const api = runtime.forPlugin('demo.example')

    expect(typeof api.stores.workspace).toBe('function')
    expect(typeof api.stores.toast).toBe('function')
  })

  it('createLogger namespaces output under plugin id', () => {
    const runtime = installPluginRuntime()
    const api = runtime.forPlugin('demo.example')
    const logger = api.createLogger('Foo')
    // We can only assert the shape — actual prefixing happens in console
    // transport. The important thing is the function compiles and runs.
    expect(typeof logger.info).toBe('function')
  })
})

describe('forPlugin — transport allowlist defaults', () => {
  it('unknown plugin id ⇒ deny-all (no manifest registered)', async () => {
    const runtime = installPluginRuntime()
    const api = runtime.forPlugin('never.registered')

    await expect(api.transport.invoke('any_command')).rejects.toBeInstanceOf(
      PluginPermissionDeniedError
    )
  })
})
