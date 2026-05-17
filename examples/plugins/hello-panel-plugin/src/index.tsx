/**
 * Hello Panel — minimal example plugin.
 *
 * Demonstrates the v0.1 Polaris plugin contract:
 *
 *   - Receive `api: PolarisPluginApi` as a prop
 *   - Reuse host React (NOT bundle our own) via `api.react`
 *   - Read host stores via `api.stores.workspace`
 *   - Use shared UI primitives (`api.ui.ConfirmDialog`)
 *   - Call sandboxed IPC via `api.transport.invoke`
 *
 * Build (when bundling for real distribution):
 *
 *   vite build --config vite.config.ts
 *
 * Output: `dist/index.js` — an ES module whose `default` export is the
 * React component below. Vite must mark `react`, `react-dom`, etc. as
 * `external` so the plugin ships only its own logic; the host injects the
 * runtime via `api.*`.
 *
 * For now this file is a *source reference* of the contract; bundling it
 * into a loadable artifact is wired up in Phase 3.
 */

// Local type-only contract. A real plugin keeps its own copy of the host
// API types so it can be developed/built without access to the host source.
import type {
  PolarisPluginApi,
} from '../../knowledge-panel-plugin/src/host-api.types'

export interface HelloPanelProps {
  api: PolarisPluginApi
}

export default function HelloPanel({ api }: HelloPanelProps) {
  const { react: React, stores, ui, transport, createLogger } = api
  const { useState, useEffect } = React
  const log = createLogger('HelloPanel')

  const workspace = stores.workspace((s) => s.getCurrentWorkspace())
  const [fileExists, setFileExists] = useState<boolean | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    if (!workspace?.path) return
    let cancelled = false
    transport
      .invoke<boolean>('path_exists', { path: `${workspace.path}/package.json` })
      .then((exists) => {
        if (!cancelled) setFileExists(exists)
      })
      .catch((err) => {
        log.warn('path_exists failed', err)
        if (!cancelled) setFileExists(null)
      })
    return () => {
      cancelled = true
    }
  }, [workspace?.path])

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui', color: 'inherit' }}>
      <h3>Hello from a Polaris plugin</h3>
      <p>API version: {api.apiVersion}</p>
      <p>Plugin id: {api.pluginId}</p>
      <p>Workspace: {workspace?.name ?? '(none)'}</p>
      <p>
        package.json exists:{' '}
        {fileExists === null ? '(unknown / no permission)' : String(fileExists)}
      </p>
      <button onClick={() => setConfirmOpen(true)}>Open host ConfirmDialog</button>

      {confirmOpen && (
        <ui.ConfirmDialog
          title="Hello from plugin"
          message="This dialog is rendered by the host's ConfirmDialog primitive."
          onConfirm={() => setConfirmOpen(false)}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  )
}
