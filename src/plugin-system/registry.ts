import type {
  PluginMcpServerContribution,
  PluginViewArea,
  PluginViewContribution,
  PluginPanelLoader,
  PluginChatCardContribution,
  PluginChatCardLoader,
  PluginEngineContribution,
  PolarisPluginManifest,
} from './types'
import { pluginPanelRegistry } from './panelRegistry'
import { chatCardRegistry } from './chatCardRegistry'
import { loadModuleFromFile, resolvePluginEntryPath } from './pluginModuleLoader'
import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'

const log = createLogger('PluginRegistry')

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
    this.registerEngines(manifest)
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
      this.registerEngines(registered)
    }
  }

  replaceInstalled(manifests: PolarisPluginManifest[]): void {
    for (const [pluginId, manifest] of this.manifests) {
      if (!manifest.builtin) {
        this.manifests.delete(pluginId)
        pluginPanelRegistry.unregisterAll(pluginId)
        chatCardRegistry.unregisterAll(pluginId)
        this.unregisterEngines(manifest)
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

  private registerChatCards(manifest: PolarisPluginManifest): void {
    const cards = manifest.contributes.chatCards
    if (!cards || cards.length === 0) return

    const ownMcpServerIds = new Set(
      (manifest.contributes.mcpServers ?? []).map((server) => server.id)
    )

    for (const card of cards) {
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
    }
  }

  private registerEngines(manifest: PolarisPluginManifest): void {
    const engines = manifest.contributes.engines
    if (!engines || engines.length === 0) return

    // 先注册所有引擎，再统一刷新 store
    Promise.all(engines.map(e => this.registerSingleEngine(e)))
      .then(() => {
        useEngineMetadataStore.getState().reload().catch(err => {
          log.warn('Failed to reload engine metadata after engine registration:', err)
        })
      })
      .catch(err => {
        log.warn(`Failed to register engines from plugin ${manifest.id}:`, err)
      })
  }

  private async registerSingleEngine(engine: PluginEngineContribution): Promise<void> {
    const engineConfig = {
      id: engine.id,
      name: engine.name,
      description: engine.description,
      cli: {
        command: engine.cli.command,
        args: engine.cli.args ?? [],
        installGuide: engine.cli.installGuide ?? '',
      },
      protocol: engine.protocol ?? 'pi-rpc',
      capabilities: {
        tools: engine.capabilities?.tools ?? true,
        streaming: engine.capabilities?.streaming ?? true,
        interrupt: engine.capabilities?.interrupt ?? true,
        resume: engine.capabilities?.resume ?? true,
      },
    }
    await invoke('register_plugin_engine', { engine: engineConfig })
    log.info(`Registered plugin engine: ${engine.id}`)
  }

  private unregisterEngines(manifest: PolarisPluginManifest): void {
    const engines = manifest.contributes.engines
    if (!engines || engines.length === 0) return

    Promise.all(engines.map(e =>
      invoke('unregister_plugin_engine', { engineId: e.id }).catch(() => {})
    )).then(() => {
      useEngineMetadataStore.getState().reload().catch(() => {})
    })
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
