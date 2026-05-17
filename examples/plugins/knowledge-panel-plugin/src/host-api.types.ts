/**
 * Local mirror of the host-provided `PolarisPluginApi` types.
 *
 * A real third-party plugin won't have access to the host's source tree, so
 * we keep an exhaustive, hand-curated copy here. Keep this file in sync with
 * `src/plugin-system/runtime/api.ts` in the host repository (it's small
 * enough that schema drift is easy to spot during code review).
 *
 * The host's `apiVersion` must satisfy `^0.1.0` for this contract to apply.
 */

import type * as React from 'react'
import type * as ReactDOM from 'react-dom/client'
import type { i18n as I18nInstance } from 'i18next'
import type { ComponentType, ReactNode } from 'react'
import type { UseBoundStore, StoreApi } from 'zustand'

// ---------------------------------------------------------------------------
// UI primitive prop shapes
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
// Store state shapes (subset we care about — the actual host stores expose
// more fields, but we only consume what KnowledgePanel needs).
// ---------------------------------------------------------------------------

/** Host's `Workspace` type — minimal fields used by Knowledge. */
export interface HostWorkspace {
  id: string
  name: string
  path: string
}

export interface HostWorkspaceState {
  workspaces: HostWorkspace[]
  currentWorkspaceId: string | null
  getCurrentWorkspace(): HostWorkspace | null
  // Other actions intentionally elided — Knowledge only reads workspace.
}

export interface HostToastState {
  success(title: string, message?: string): string
  error(title: string, message?: string): string
  warning(title: string, message?: string): string
  info(title: string, message?: string): string
  removeToast(id: string): void
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

type AnyCtx = Record<string, unknown>

export interface HostModuleLogger {
  trace(message: string, context?: AnyCtx): void
  debug(message: string, context?: AnyCtx): void
  info(message: string, context?: AnyCtx): void
  warn(message: string, context?: AnyCtx): void
  error(message: string, error?: unknown, context?: AnyCtx): void
  fatal(message: string, error?: unknown, context?: AnyCtx): void
  child(subModule: string): HostModuleLogger
}

export type HostCreateLogger = (module: string) => HostModuleLogger

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface PluginTransport {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>
  listen<T = unknown>(
    event: string,
    handler: (payload: T) => void
  ): Promise<() => void>
}

// ---------------------------------------------------------------------------
// Top-level API
// ---------------------------------------------------------------------------

export interface PolarisPluginApi {
  readonly apiVersion: string
  readonly pluginId: string

  readonly react: typeof React
  readonly reactDom: typeof ReactDOM
  readonly i18n: I18nInstance

  readonly stores: {
    workspace: UseBoundStore<StoreApi<HostWorkspaceState>>
    toast: UseBoundStore<StoreApi<HostToastState>>
  }

  readonly ui: {
    ConfirmDialog: ComponentType<PluginConfirmDialogProps>
    ZoomableDiagramContainer: ComponentType<PluginZoomableDiagramProps>
    CodeMirrorEditor: ComponentType<PluginCodeMirrorEditorProps>
    ProgressiveStreamingMarkdown: ComponentType<PluginProgressiveMarkdownProps>
  }

  readonly transport: PluginTransport
  convertFileSrc(filePath: string, protocol?: string): string
  createLogger: HostCreateLogger

  readonly lazy: {
    mermaid(): Promise<typeof import('mermaid').default>
  }
}
