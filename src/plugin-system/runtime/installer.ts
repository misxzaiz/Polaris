/**
 * Plugin runtime installer.
 *
 * Boots the host-side singleton (`window.__POLARIS__`) so plugins loaded
 * later in the session can call `window.__POLARIS__.forPlugin(pluginId)` to
 * obtain a typed `PolarisPluginApi`.
 *
 * Call `installPluginRuntime()` exactly once, before any plugin code runs.
 * In production this happens in `src/main.tsx` right after i18n bootstraps.
 *
 * Idempotency: re-installation is a no-op (returns the existing runtime).
 * This keeps Vite HMR from clobbering plugin state during development.
 */

import * as React from 'react'
import * as ReactDOM from 'react-dom/client'
import { convertFileSrc as tauriConvertFileSrc } from '@tauri-apps/api/core'

import i18n from '@/i18n'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useToastStore } from '@/stores/toastStore'
import { createLogger } from '@/utils/logger'

import { ConfirmDialog } from '@/components/Common/ConfirmDialog'
import { ZoomableDiagramContainer } from '@/components/Common/ZoomableDiagramContainer'
import { CodeMirrorEditor } from '@/components/Editor'
import { ProgressiveStreamingMarkdown } from '@/utils/lightweightMarkdown'

import type { PolarisHostRuntime, PolarisPluginApi } from './api'
import { HOST_API_VERSION, satisfies } from './version'
import { createPluginTransport } from './transport'
import { pluginRegistry } from '../registry'

const log = createLogger('PluginRuntime')

// ---------------------------------------------------------------------------
// Private: per-plugin API minting
// ---------------------------------------------------------------------------

function mintApiForPlugin(pluginId: string): PolarisPluginApi {
  // Look up the registered manifest. Builtin plugins go through this same
  // path: their manifests have no `permissions.ipc` so transport is deny-all
  // for them — that's intentional, they use the bare `@/services/transport`
  // directly inside the bundle.
  const manifest = pluginRegistry.listPlugins().find((p) => p.id === pluginId)
  const ipcAllowlist = manifest?.permissions?.ipc

  const transport = createPluginTransport({ pluginId, ipcAllowlist })

  // Per-plugin logger so console output is attributable.
  const pluginCreateLogger: typeof createLogger = (subModule, options) =>
    createLogger(`Plugin[${pluginId}]:${subModule}`, options)

  return {
    apiVersion: HOST_API_VERSION,
    pluginId,
    react: React,
    reactDom: ReactDOM,
    i18n,
    stores: {
      workspace: useWorkspaceStore,
      toast: useToastStore,
    },
    ui: {
      ConfirmDialog,
      ZoomableDiagramContainer,
      CodeMirrorEditor,
      ProgressiveStreamingMarkdown,
    },
    transport,
    convertFileSrc: tauriConvertFileSrc,
    createLogger: pluginCreateLogger,
    lazy: {
      mermaid: () => import('mermaid').then((m) => m.default),
    },
  }
}

// ---------------------------------------------------------------------------
// Public: install once at app boot
// ---------------------------------------------------------------------------

let installed: PolarisHostRuntime | null = null

export function installPluginRuntime(): PolarisHostRuntime {
  if (installed) {
    log.debug('plugin runtime already installed, skipping')
    return installed
  }

  const runtime: PolarisHostRuntime = {
    apiVersion: HOST_API_VERSION,
    apiVersionSatisfies(range: string) {
      return satisfies(HOST_API_VERSION, range)
    },
    forPlugin(pluginId: string) {
      return mintApiForPlugin(pluginId)
    },
  }

  if (typeof window !== 'undefined') {
    window.__POLARIS__ = runtime
  }
  installed = runtime

  log.info('plugin runtime installed', { apiVersion: HOST_API_VERSION })
  return runtime
}

/**
 * Test helper: tear down the runtime so the next `installPluginRuntime()`
 * call re-initializes. Production code never needs this.
 */
export function __resetPluginRuntimeForTests(): void {
  installed = null
  if (typeof window !== 'undefined') {
    delete window.__POLARIS__
  }
}
