import type {
  PluginMcpServerContribution,
  PluginViewArea,
  PluginViewContribution,
  PluginPanelLoader,
  PluginChatCardContribution,
  PluginChatCardLoader,
  PolarisPluginManifest,
} from './types'
import { pluginPanelRegistry } from './panelRegistry'
import { chatCardRegistry } from './chatCardRegistry'
import { loadModuleFromFile, resolvePluginEntryPath } from './pluginModuleLoader'

function createPanelLoader(pluginInstallPath: string, entry: string): PluginPanelLoader {
  const fullPath = resolvePluginEntryPath(pluginInstallPath, entry)
  return () => loadModuleFromFile(fullPath) as Promise<{ default: React.ComponentType<any> }>
}

function createChatCardLoader(pluginInstallPath: string, entry: string): PluginChatCardLoader {
  const fullPath = resolvePluginEntryPath(pluginInstallPath, entry)
  return () => loadModuleFromFile(fullPath) as Promise<{ default: React.ComponentType<any> }>
}

class PluginRegistry {
  private manifests = new Map<string, PolarisPluginManifest>()

  register(manifest: PolarisPluginManifest): void {
    this.manifests.set(manifest.id, manifest)
    this.registerPanel(manifest)
    this.registerChatCards(manifest)
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
      this.registerChatCards(registered)
    }
  }

  replaceInstalled(manifests: PolarisPluginManifest[]): void {
    for (const [pluginId, manifest] of this.manifests) {
      if (!manifest.builtin) {
        this.manifests.delete(pluginId)
        pluginPanelRegistry.unregisterAll(pluginId)
        chatCardRegistry.unregisterAll(pluginId)
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

  /**
   * 注册插件声明的聊天卡片。仅外部插件（有 installPath + entry）在此自动注册；
   * 内置插件的卡片 loader 在 builtinPlugins.ts 手动注册（无 installPath）。
   */
  private registerChatCards(manifest: PolarisPluginManifest): void {
    const cards = manifest.contributes.chatCards
    if (!cards || cards.length === 0) return

    const ownMcpServerIds = new Set(
      (manifest.contributes.mcpServers ?? []).map((server) => server.id)
    )

    for (const card of cards) {
      // 安全校验：mcpServerId 必须属于本插件（外部插件 discovery 已校验过，
      // 此处对内置/直接 register 的 manifest 再保底一次）
      if (!ownMcpServerIds.has(card.mcpServerId)) {
        continue
      }

      if (card.entry && manifest.installPath) {
        chatCardRegistry.register(
          manifest.id,
          card,
          createChatCardLoader(manifest.installPath, card.entry)
        )
      }
      // 无 entry 的内置卡片由 builtinPlugins.ts 手动 register(loader)
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

  listChatCardContributions(): PluginChatCardContribution[] {
    return this.listPlugins()
      .filter((plugin) => plugin.enabledByDefault)
      .flatMap((plugin) =>
        (plugin.contributes.chatCards ?? []).map((card) => ({
          ...card,
          pluginId: plugin.id,
        }))
      )
  }
}

export const pluginRegistry = new PluginRegistry()
