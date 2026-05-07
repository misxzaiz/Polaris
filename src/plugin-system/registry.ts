import type {
  PluginMcpServerContribution,
  PluginViewArea,
  PluginViewContribution,
  PolarisPluginManifest,
} from './types'

class PluginRegistry {
  private manifests = new Map<string, PolarisPluginManifest>()

  register(manifest: PolarisPluginManifest): void {
    this.manifests.set(manifest.id, manifest)
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
      .filter((plugin) => plugin.enabledByDefault)
      .flatMap((plugin) =>
        (plugin.contributes.mcpServers ?? []).map((server) => ({
          ...server,
          pluginId: plugin.id,
        }))
      )
  }
}

export const pluginRegistry = new PluginRegistry()

