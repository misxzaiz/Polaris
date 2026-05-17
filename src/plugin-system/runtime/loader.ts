/**
 * Plugin panel loader.
 *
 * Loads a plugin's `entryUrl` as an ES module, validates the export shape,
 * and returns a React component that the host can render inside a normal
 * Suspense boundary.
 *
 * ## Contract
 *
 * A plugin entry **must** default-export a React component whose props
 * include an `api: PolarisPluginApi` field:
 *
 * ```tsx
 * export default function MyPanel({ api }: { api: PolarisPluginApi }) {
 *   return <div>...</div>
 * }
 * ```
 *
 * The host calls `loadPluginPanel(...)` once, then renders
 * `<LoadedComponent api={api} />` wherever the panel belongs. React handles
 * the lifecycle from there.
 *
 * ## Why no `mount(rootEl, api)` ?
 *
 * That pattern fights React's reconciler — every plugin would have to
 * manage its own root, defeating Suspense, error boundaries, and StrictMode.
 * Default-exporting a component keeps plugins inside the host's React tree.
 */

import type { ComponentType } from 'react'
import { assertHostSatisfies } from './version'
import type { PolarisPluginApi } from './api'

export interface LoadPluginPanelOptions {
  pluginId: string
  /**
   * URL the webview can `import()`. In production this is typically
   * `convertFileSrc(<pluginDir>/<entry>)`. In dev tests, an inline
   * `data:text/javascript,...` URI works too.
   */
  entryUrl: string
  /**
   * Optional semver range the plugin requires of the host. If present and
   * unsatisfied, loading throws `PluginApiVersionMismatchError` before any
   * network/disk I/O.
   */
  requiredApiVersion?: string
  /**
   * Override for the ES dynamic import. Tests inject a stub to bypass real
   * module fetching. Production code should leave this undefined.
   */
  dynamicImport?: (url: string) => Promise<unknown>
}

export type PluginPanelComponent = ComponentType<{ api: PolarisPluginApi }>

export class PluginLoadError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly entryUrl: string,
    public readonly cause: unknown
  ) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause)
    super(`Failed to load plugin "${pluginId}" from ${entryUrl}: ${causeMsg}`)
    this.name = 'PluginLoadError'
  }
}

export class PluginEntryShapeError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly reason: string
  ) {
    super(`Plugin "${pluginId}" entry has wrong shape: ${reason}`)
    this.name = 'PluginEntryShapeError'
  }
}

/**
 * Default dynamic import. Marked `@vite-ignore` so Vite leaves runtime
 * specifiers alone — they're not resolvable at build time.
 */
function defaultDynamicImport(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url)
}

export async function loadPluginPanel(
  options: LoadPluginPanelOptions
): Promise<PluginPanelComponent> {
  const { pluginId, entryUrl, requiredApiVersion } = options

  if (requiredApiVersion) {
    assertHostSatisfies(pluginId, requiredApiVersion)
  }

  const doImport = options.dynamicImport ?? defaultDynamicImport

  let mod: unknown
  try {
    mod = await doImport(entryUrl)
  } catch (err) {
    throw new PluginLoadError(pluginId, entryUrl, err)
  }

  if (!mod || typeof mod !== 'object') {
    throw new PluginEntryShapeError(
      pluginId,
      `module resolved to ${typeof mod} (expected object with default export)`
    )
  }
  const def = (mod as { default?: unknown }).default
  if (typeof def !== 'function') {
    throw new PluginEntryShapeError(
      pluginId,
      `default export is ${typeof def} (expected React component)`
    )
  }

  return def as PluginPanelComponent
}
