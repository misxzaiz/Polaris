/**
 * PolarisPluginApi — host-exposed runtime contract for Polaris plugins.
 *
 * Plugins receive an instance of this interface (typically via the
 * `window.__POLARIS__` global injected by `installer.ts`, or as the second
 * argument to a plugin's `mount(rootEl, api)` function).
 *
 * ## Design intent
 *
 * - **Single React instance**: plugins must reuse the host's React/ReactDOM
 *   so hooks, context, and Suspense work across the host/plugin boundary.
 *   Plugin build configs must mark `react` and `react-dom` as external.
 * - **Single i18next instance**: shared localization, plugins register their
 *   own resource bundles via `api.i18n.addResourceBundle(...)`.
 * - **Single Zustand store registry**: plugins read host stores through the
 *   provided hooks (`api.stores.workspace`, `api.stores.toast`).
 * - **Mediated IPC**: `api.transport.invoke` enforces the plugin's manifest
 *   `permissions.ipc` allowlist (see `transport.ts`).
 * - **Stable versioning**: `api.apiVersion` follows semver. Plugins declare
 *   `apiVersion` in their manifest and the host refuses to load plugins
 *   whose required range does not satisfy the host's actual version.
 *
 * ## Not in scope for v1
 *
 * - Plugin-contributed IPC commands (one-way invoke only, no plugin → host
 *   command registration).
 * - Plugin-contributed event channels (plugins cannot publish events on the
 *   host's bus; they can subscribe via `transport.listen` if granted).
 * - Mutable Zustand store access — plugins receive the standard hook and
 *   can call actions; sandbox-grade write isolation is left to Phase 6.
 */

import type * as React from 'react'
import type * as ReactDOM from 'react-dom/client'
import type { i18n as I18nInstance } from 'i18next'
import type { ComponentType, ReactNode } from 'react'

import type { useWorkspaceStore } from '@/stores/workspaceStore'
import type { useToastStore } from '@/stores/toastStore'
import type { createLogger as CreateLogger } from '@/utils/logger'

// ---------------------------------------------------------------------------
// UI primitives — narrowed prop types so plugins don't import host internals.
// ---------------------------------------------------------------------------

export interface PluginConfirmDialogProps {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  onConfirm: () => void
  onCancel: () => void
  type?: 'danger' | 'warning' | 'info'
}

export interface PluginZoomableDiagramProps {
  children: ReactNode
  minHeight?: number
  loading?: boolean
  error?: string | null
  errorRenderer?: (error: string) => ReactNode
}

export interface PluginCodeMirrorEditorProps {
  value: string
  language: string
  onChange: (value: string) => void
  readOnly?: boolean
  onSave?: () => void
  lineNumbers?: boolean
  wrapEnabled?: boolean
  filePath?: string
}

export interface PluginProgressiveMarkdownProps {
  content: string
  completed?: boolean
}

// ---------------------------------------------------------------------------
// Transport — IPC bridge with manifest-driven allowlist.
// ---------------------------------------------------------------------------

/**
 * Mediated `invoke()` for plugin → host backend calls.
 *
 * The command name is checked against the calling plugin's manifest
 * `permissions.ipc` allowlist. Disallowed calls reject with
 * `PluginPermissionDeniedError` *before* hitting the transport layer.
 *
 * Plugins are *not* given the host's bare `invoke` from `@/services/transport`.
 */
export interface PluginTransport {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>
  /**
   * Subscribe to a host event. Returns an unsubscribe function. Subject to
   * the same per-plugin allowlist as `invoke` (using the event name as the
   * permission key).
   */
  listen<T = unknown>(
    event: string,
    handler: (payload: T) => void
  ): Promise<() => void>
}

// ---------------------------------------------------------------------------
// The full host-facing surface.
// ---------------------------------------------------------------------------

export interface PolarisPluginApi {
  /** Semver string. Plugins compare via `host.apiVersionSatisfies(range)`. */
  readonly apiVersion: string

  /** The plugin id this API instance was minted for. Read-only. */
  readonly pluginId: string

  /** Shared React runtime — plugins MUST reuse, not bundle their own. */
  readonly react: typeof React
  readonly reactDom: typeof ReactDOM

  /** Shared i18next singleton. Plugins should `addResourceBundle` on mount. */
  readonly i18n: I18nInstance

  /** Shared Zustand stores (full hook surface). */
  readonly stores: {
    workspace: typeof useWorkspaceStore
    toast: typeof useToastStore
  }

  /** Shared UI primitives. Plugin authors get host-quality components for free. */
  readonly ui: {
    ConfirmDialog: ComponentType<PluginConfirmDialogProps>
    ZoomableDiagramContainer: ComponentType<PluginZoomableDiagramProps>
    CodeMirrorEditor: ComponentType<PluginCodeMirrorEditorProps>
    ProgressiveStreamingMarkdown: ComponentType<PluginProgressiveMarkdownProps>
  }

  /** Mediated IPC transport. */
  readonly transport: PluginTransport

  /**
   * Convert an absolute local file path to a URL the webview can load
   * (`tauri://localhost/...` on Windows/Linux, `asset://...` on macOS).
   * Plugins use this to reference their own bundled assets on disk.
   */
  convertFileSrc(filePath: string, protocol?: string): string

  /** Scoped logger factory. Output namespace will be prefixed by plugin id. */
  createLogger: typeof CreateLogger

  /** Lazy-loaded heavy dependencies that the host already bundles. */
  readonly lazy: {
    mermaid(): Promise<typeof import('mermaid').default>
  }
}

// ---------------------------------------------------------------------------
// Global augmentation — `window.__POLARIS__` is provided by installer.ts.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    /**
     * Host runtime root. Installed once on app boot. Plugins should obtain
     * their per-plugin API via `window.__POLARIS__.forPlugin(pluginId)`
     * rather than reading fields off this object directly.
     */
    __POLARIS__?: PolarisHostRuntime
  }
}

/**
 * The single host-side facade. Mints per-plugin `PolarisPluginApi` instances
 * with the right `pluginId` baked in for transport allowlist enforcement.
 */
export interface PolarisHostRuntime {
  readonly apiVersion: string
  /** Returns true iff the host satisfies the given semver range. */
  apiVersionSatisfies(range: string): boolean
  /** Mint an API for a given plugin id (used by the host's plugin loader). */
  forPlugin(pluginId: string): PolarisPluginApi
}
