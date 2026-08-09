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
  /** engineId → pluginId 映射（用于引擎设置页定位来源插件） */
  private engineToPlugin = new Map<string, string>()

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

  replaceInstalled(manifests: PolarisPluginManifest[]): Promise<void> {
    // 先收集所有待卸载的引擎注册（异步 fire-and-forget）
    const unregisterPromises: Promise<void>[] = []
    for (const [pluginId, manifest] of this.manifests) {
      if (!manifest.builtin) {
        this.manifests.delete(pluginId)
        pluginPanelRegistry.unregisterAll(pluginId)
        chatCardRegistry.unregisterAll(pluginId)
        this.clearEngineMapping(pluginId)
        unregisterPromises.push(this.unregisterEngines(manifest))
      }
    }

    // 同步注册新插件清单（面板、卡片等），listPlugins() 立即可见
    // 先收集引擎配置，等旧引擎卸载完成后再注册（避免竞态）
    const engineConfigs: PolarisPluginManifest[] = []
    for (const manifest of manifests) {
      const existing = this.manifests.get(manifest.id)
      if (existing?.builtin) continue

      const registered = { ...manifest, builtin: false }
      this.manifests.set(manifest.id, registered)
      this.registerPanel(registered)
      this.registerChatCards(registered)
      engineConfigs.push(registered)
    }

    // 等旧引擎卸载完成后，再注册新引擎
    return Promise.all(unregisterPromises)
      .then(() => Promise.all(engineConfigs.map(m => this.registerEngines(m))))
      .then(() => {})
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

  private registerEngines(manifest: PolarisPluginManifest): Promise<void> {
    const engines = manifest.contributes.engines
    if (!engines || engines.length === 0) return Promise.resolve()

    // 记录引擎→插件映射
    this.recordEngineMapping(manifest)

    // 先注册所有引擎，再统一刷新 store
    return Promise.all(engines.map(e => this.registerSingleEngine(e)))
      .then(() => {
        log.info(`[PluginRegistry] 已注册 ${engines.length} 个插件引擎，刷新引擎元数据 store`)
        return useEngineMetadataStore.getState().reload().then(() => {
          const ids = useEngineMetadataStore.getState().getEngineIds()
          log.info(`[PluginRegistry] 刷新后引擎列表: [${ids.join(', ')}]`)
        }).catch(err => {
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
      sessionFlags: engine.sessionFlags ?? 'pi',
      providerConfig: engine.providerConfig,
      mcpConsumption: engine.mcpConsumption ?? 'mcp-servers',
      capabilities: {
        tools: engine.capabilities?.tools ?? true,
        streaming: engine.capabilities?.streaming ?? true,
        interrupt: engine.capabilities?.interrupt ?? true,
        resume: engine.capabilities?.resume ?? true,
      },
    }
    log.info(`[registerSingleEngine] engine.id=${engine.id}, source sessionFlags=${engine.sessionFlags ?? 'undefined'}, final sessionFlags=${engineConfig.sessionFlags}, hasProviderConfig=${!!engineConfig.providerConfig}`)
    log.info(`[PluginRegistry] 调用 register_plugin_engine: ${JSON.stringify(engineConfig)}`)
    await invoke('register_plugin_engine', { engine: engineConfig })
    log.info(`[PluginRegistry] 引擎注册成功: ${engine.id}`)
  }

  /** 记录引擎 → 插件映射（在引擎贡献点注册后调用） */
  private recordEngineMapping(manifest: PolarisPluginManifest): void {
    for (const engine of manifest.contributes.engines ?? []) {
      this.engineToPlugin.set(engine.id, manifest.id)
    }
  }

  /** 清理某插件的引擎映射（卸载/替换时） */
  private clearEngineMapping(pluginId: string): void {
    for (const [engineId, pid] of this.engineToPlugin) {
      if (pid === pluginId) this.engineToPlugin.delete(engineId)
    }
  }

  /** 获取指定引擎的来源插件 ID（未找到返回 undefined） */
  getPluginIdForEngine(engineId: string): string | undefined {
    return this.engineToPlugin.get(engineId)
  }

  private unregisterEngines(manifest: PolarisPluginManifest): Promise<void> {
    const engines = manifest.contributes.engines
    if (!engines || engines.length === 0) return Promise.resolve()

    return Promise.all(engines.map(e =>
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
