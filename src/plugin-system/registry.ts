import type {
  PluginMcpServerContribution,
  PluginViewArea,
  PluginViewContribution,
  PluginPanelLoader,
  PolarisPluginManifest,
} from './types'
import { pluginPanelRegistry } from './panelRegistry'
import { readFile } from '@/services/tauri/fileService'

let shimUrl: string | null = null

async function ensureReactShim(): Promise<string> {
  if (shimUrl) return shimUrl

  const shimCode = `
    const R = window.__POLARIS_HOST_REACT__;
    const J = window.__POLARIS_HOST_REACT_JSX__;
    if (!R) throw new Error('Host React not found on window.__POLARIS_HOST_REACT__');
    export const useState = R.useState;
    export const useEffect = R.useEffect;
    export const useCallback = R.useCallback;
    export const useMemo = R.useMemo;
    export const useRef = R.useRef;
    export const createElement = R.createElement;
    export const Fragment = R.Fragment;
    export const Component = R.Component;
    export default R;
    export const jsx = J.jsx;
    export const jsxs = J.jsxs;
    export const jsx_Fragment = J.Fragment;
  `
  const blob = new Blob([shimCode], { type: 'application/javascript' })
  shimUrl = URL.createObjectURL(blob)
  return shimUrl
}

async function loadModuleFromFile(filePath: string): Promise<Record<string, unknown>> {
  const code = await readFile(filePath)
  const reactShimUrl = await ensureReactShim()

  const patchedCode = code
    .replace(/from\s*["']react["']/g, `from "${reactShimUrl}"`)
    .replace(/from\s*["']react\/jsx-runtime["']/g, `from "${reactShimUrl}"`)
    .replace(/require\(\s*["']react["']\s*\)/g, `require("${reactShimUrl}")`)
    .replace(/require\(\s*["']react\/jsx-runtime["']\s*\)/g, `require("${reactShimUrl}")`)

  const blob = new Blob([patchedCode], { type: 'application/javascript' })
  const blobUrl = URL.createObjectURL(blob)

  try {
    const mod = await import(/* @vite-ignore */ blobUrl)
    return mod
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

function createPanelLoader(pluginInstallPath: string, entry: string): PluginPanelLoader {
  const basePath = pluginInstallPath.replace(/\\/g, '/')
  const entryPath = entry.startsWith('./') ? entry.slice(2) : entry
  const fullPath = `${basePath}/${entryPath}`
  return () => loadModuleFromFile(fullPath) as Promise<{ default: React.ComponentType<any> }>
}

class PluginRegistry {
  private manifests = new Map<string, PolarisPluginManifest>()

  register(manifest: PolarisPluginManifest): void {
    this.manifests.set(manifest.id, manifest)
    this.registerPanel(manifest)
  }

  registerInstalled(manifests: PolarisPluginManifest[]): void {
    for (const manifest of manifests) {
      const existing = this.manifests.get(manifest.id)
      if (existing?.builtin) {
        continue
      }

      const registered = { ...manifest, builtin: false }
      this.manifests.set(manifest.id, registered)
      this.registerPanel(registered)
    }
  }

  replaceInstalled(manifests: PolarisPluginManifest[]): void {
    for (const [pluginId, manifest] of this.manifests) {
      if (!manifest.builtin) {
        this.manifests.delete(pluginId)
        pluginPanelRegistry.unregisterAll(pluginId)
      }
    }

    this.registerInstalled(manifests)
  }

  private registerPanel(manifest: PolarisPluginManifest): void {
    const panel = manifest.contributes.panel
    if (!panel?.entry || !manifest.installPath) return

    const views = manifest.contributes.views ?? []
    if (views.length === 0) return

    for (const view of views) {
      pluginPanelRegistry.register(
        view.panelType,
        manifest.id,
        createPanelLoader(manifest.installPath, panel.entry)
      )
    }
  }

  listPlugins(): PolarisPluginManifest[] {
    return Array.from(this.manifests.values())
  }

  listViewContributions(area: PluginViewArea): PluginViewContribution[] {
    return this.listPlugins()
      .filter((plugin) => plugin.enabledByDefault)
      .flatMap((plugin) =>
        (plugin.contributes.views ?? [])
          .filter((view) => view.area === area)
          .map((view) => ({
            ...view,
            pluginId: plugin.id,
          }))
      )
      .sort((a, b) => a.order - b.order)
  }

  listMcpServerContributions(): PluginMcpServerContribution[] {
    return this.listPlugins()
      .flatMap((plugin) =>
        (plugin.contributes.mcpServers ?? []).map((server) => ({
          ...server,
          pluginId: plugin.id,
        }))
      )
  }
}

export const pluginRegistry = new PluginRegistry()
