/**
 * Plugin-side runtime bridge.
 *
 * The plugin entry receives `PolarisPluginApi` from the host and stashes it
 * here via `setHostApi(api)`. Every subsequent host capability used by the
 * plugin's existing code (logger, transport, file system, stores, UI
 * primitives) is mediated through this module so the source files only need
 * a *path* rewrite (`@/utils/logger` → `../runtime`), not a structural one.
 *
 * ## Why module-level instead of React context?
 *
 * KnowledgePanel's original code grabs `createLogger`, `invoke`, file IO at
 * module top, before any React tree exists. Wrapping every consumer in a
 * Context.Provider would force a far larger refactor. A module-level singleton
 * works because a plugin's `dist/index.js` is loaded exactly once per host
 * session — there is no risk of two competing API instances.
 *
 * ## Lazy resolution
 *
 * `setHostApi()` runs in the plugin's default-export component **after**
 * module evaluation. To let `const log = createLogger('X')` stay at module
 * top, the `createLogger` exported here returns a *proxy logger* whose
 * methods defer to `host()` at call time — not import time.
 */

import type {
  PluginConfirmDialogProps,
  PluginZoomableDiagramProps,
  PluginCodeMirrorEditorProps,
  PluginProgressiveMarkdownProps,
  PolarisPluginApi,
} from './host-api.types'
import type { ComponentType } from 'react'

// ---------------------------------------------------------------------------
// Host accessor
// ---------------------------------------------------------------------------

let _api: PolarisPluginApi | null = null

export function setHostApi(api: PolarisPluginApi): void {
  _api = api
}

export function host(): PolarisPluginApi {
  if (!_api) {
    throw new Error(
      '@polaris-plugins/knowledge-panel: host API not initialized. ' +
        'Call setHostApi(api) from the plugin entry before using runtime accessors.'
    )
  }
  return _api
}

// ---------------------------------------------------------------------------
// Lazy logger — mirrors `@/utils/logger.createLogger` surface.
//
// Returned object's methods resolve `host().createLogger(tag)` lazily so it
// can live at module top.
// ---------------------------------------------------------------------------

type AnyCtx = Record<string, unknown>

export interface ModuleLogger {
  trace(message: string, context?: AnyCtx): void
  debug(message: string, context?: AnyCtx): void
  info(message: string, context?: AnyCtx): void
  warn(message: string, context?: AnyCtx): void
  error(message: string, error?: unknown, context?: AnyCtx): void
  fatal(message: string, error?: unknown, context?: AnyCtx): void
}

export function createLogger(tag: string): ModuleLogger {
  // Cache the underlying logger on first call to avoid re-creating it.
  let resolved: ReturnType<PolarisPluginApi['createLogger']> | null = null
  const resolve = () => {
    if (!resolved) resolved = host().createLogger(tag)
    return resolved
  }
  return {
    trace: (msg, ctx) => resolve().trace(msg, ctx),
    debug: (msg, ctx) => resolve().debug(msg, ctx),
    info: (msg, ctx) => resolve().info(msg, ctx),
    warn: (msg, ctx) => resolve().warn(msg, ctx),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    error: (msg, err?: any, ctx?: AnyCtx) => resolve().error(msg, err, ctx),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fatal: (msg, err?: any, ctx?: AnyCtx) => resolve().fatal(msg, err, ctx),
  }
}

// ---------------------------------------------------------------------------
// Transport — drop-in replacement for `@/services/transport.invoke`
// ---------------------------------------------------------------------------

export function invoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  return host().transport.invoke<T>(command, args)
}

// ---------------------------------------------------------------------------
// File system facade — mirrors `@/services/tauri/fileService` subset used by
// knowledgeService.ts. Command names match the actual Tauri IPC contract.
// ---------------------------------------------------------------------------

export const fs = {
  readFile(path: string): Promise<string> {
    return invoke<string>('get_file_content', { path })
  },
  readDirectory(path: string): Promise<unknown[]> {
    return invoke<unknown[]>('read_directory', { path })
  },
  deleteFile(path: string): Promise<void> {
    return invoke<void>('delete_file', { path })
  },
  createDirectory(path: string): Promise<void> {
    return invoke<void>('create_directory', { path })
  },
  createFile(path: string, content: string): Promise<void> {
    return invoke<void>('create_file', { path, content })
  },
  pathExists(path: string): Promise<boolean> {
    return invoke<boolean>('path_exists', { path })
  },
}

// ---------------------------------------------------------------------------
// Store accessors — exposed for `useWorkspaceStore(selector)` patterns
// ---------------------------------------------------------------------------

type WorkspaceState = ReturnType<PolarisPluginApi['stores']['workspace']['getState']>
type ToastState = ReturnType<PolarisPluginApi['stores']['toast']['getState']>

export function useWorkspaceStore(): WorkspaceState
export function useWorkspaceStore<T>(selector: (state: WorkspaceState) => T): T
export function useWorkspaceStore<T>(
  selector?: (state: WorkspaceState) => T
): T | WorkspaceState {
  const store = host().stores.workspace
  return selector ? store(selector) : store()
}

export const toast = {
  success: (title: string, message?: string) =>
    host().stores.toast.getState().success(title, message),
  error: (title: string, message?: string) =>
    host().stores.toast.getState().error(title, message),
  warning: (title: string, message?: string) =>
    host().stores.toast.getState().warning(title, message),
  info: (title: string, message?: string) =>
    host().stores.toast.getState().info(title, message),
}

// ---------------------------------------------------------------------------
// Shared UI primitives — exposed as React components so plugin source can
// keep `<ConfirmDialog ... />` JSX without any rewrite. Wrapped functions
// resolve `host().ui.<X>` lazily at render time.
// ---------------------------------------------------------------------------

export function ConfirmDialog(props: PluginConfirmDialogProps) {
  const Comp = host().ui.ConfirmDialog
  return <Comp {...props} />
}

export function ZoomableDiagramContainer(props: PluginZoomableDiagramProps) {
  const Comp = host().ui.ZoomableDiagramContainer
  return <Comp {...props} />
}

export function CodeMirrorEditor(props: PluginCodeMirrorEditorProps) {
  const Comp = host().ui.CodeMirrorEditor
  return <Comp {...props} />
}

export function ProgressiveStreamingMarkdown(props: PluginProgressiveMarkdownProps) {
  const Comp = host().ui.ProgressiveStreamingMarkdown
  return <Comp {...props} />
}

// `ui` namespace kept for callers that prefer `ui.ConfirmDialog`.
export const ui = {
  get ConfirmDialog(): ComponentType<PluginConfirmDialogProps> {
    return host().ui.ConfirmDialog
  },
  get ZoomableDiagramContainer(): ComponentType<PluginZoomableDiagramProps> {
    return host().ui.ZoomableDiagramContainer
  },
  get CodeMirrorEditor(): ComponentType<PluginCodeMirrorEditorProps> {
    return host().ui.CodeMirrorEditor
  },
  get ProgressiveStreamingMarkdown(): ComponentType<PluginProgressiveMarkdownProps> {
    return host().ui.ProgressiveStreamingMarkdown
  },
}

// ---------------------------------------------------------------------------
// Hook re-exports — let plugin code import { useToastStore, useWorkspaceStore }
// and useToastStore-equivalent without ever knowing about host()
// ---------------------------------------------------------------------------

export function useToastStore(): ToastState
export function useToastStore<T>(selector: (state: ToastState) => T): T
export function useToastStore<T>(selector?: (state: ToastState) => T): T | ToastState {
  const store = host().stores.toast
  return selector ? store(selector) : store()
}

// `getMermaidConfig` shim: the host's `@/utils/mermaid-config.getMermaidConfig`
// returns a Mermaid `MermaidConfig` for the current theme. We don't replicate
// the implementation here — the plugin uses host().lazy.mermaid() and a
// minimal dark config (KnowledgeDependencyGraph only ever needs one shape).
export function getMermaidConfig(_theme: 'dark' | 'light' = 'dark'): Record<string, unknown> {
  return {
    theme: 'dark',
    securityLevel: 'loose',
    flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
    themeVariables: {
      primaryColor: '#1e293b',
      primaryTextColor: '#e2e8f0',
      primaryBorderColor: '#334155',
      lineColor: '#64748b',
      secondaryColor: '#0f172a',
      tertiaryColor: '#1e293b',
    },
  }
}

// ---------------------------------------------------------------------------
// Mermaid helper — gated through host so the plugin can't double-bundle it.
// ---------------------------------------------------------------------------

export async function getMermaid(): Promise<typeof import('mermaid').default> {
  return host().lazy.mermaid()
}

export type { PolarisPluginApi } from './host-api.types'
