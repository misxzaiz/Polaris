import type {
  PluginMcpServerContribution,
  PluginOverlayContribution,
  PluginStyleContribution,
  PluginToolProviderContribution,
  PluginViewArea,
  PluginViewContribution,
  PluginPanelLoader,
  PluginChatCardContribution,
  PluginChatCardLoader,
  PluginEngineContribution,
  PolarisPluginManifest,
  PluginCapabilityContribution,
} from './types'
import { pluginPanelRegistry } from './panelRegistry'
import { chatCardRegistry } from './chatCardRegistry'
import { uiTemplateRegistry } from './uiTemplateRegistry'
import { loadModuleFromFile, resolvePluginEntryPath } from './pluginModuleLoader'
import { pushPluginContext, popPluginContext } from './pluginContext'
import { hydratePluginUi } from './uiContributions'
import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'
import {
  usePluginStore,
  registerPluginDefaultUi,
  clearPluginDefaultUi,
  isPluginUiEnabled,
} from '@/stores/pluginStore'

const log = createLogger('PluginRegistry')

function createPanelLoader(pluginInstallPath: string, entry: string, pluginId: string): PluginPanelLoader {
  const fullPath = resolvePluginEntryPath(pluginInstallPath, entry)
  return async () => {
    // P1.3：面板模块同步 import 期间标记插件上下文——宿主桥（listen 过滤等）
    // 据此按 manifest permissions 裁决（ai-chat-plugin-extraction-spec）。
    pushPluginContext(pluginId)
    try {
      return (await loadModuleFromFile(fullPath)) as { default: React.ComponentType<any> }
    } finally {
      popPluginContext(pluginId)
    }
  }
}

function createChatCardLoader(pluginInstallPath: string, entry: string, pluginId: string): PluginChatCardLoader {
  const fullPath = resolvePluginEntryPath(pluginInstallPath, entry)
  return async () => {
    pushPluginContext(pluginId)
    try {
      return (await loadModuleFromFile(fullPath)) as { default: React.ComponentType<any> }
    } finally {
      popPluginContext(pluginId)
    }
  }
}

class PluginRegistry {
  private manifests = new Map<string, PolarisPluginManifest>()
  /** engineId → pluginId 映射（用于引擎设置页定位来源插件） */
  private engineToPlugin = new Map<string, string>()

  register(manifest: PolarisPluginManifest): void {
    this.manifests.set(manifest.id, manifest)
    // 可见性默认值（enabledByDefault 仅作初始默认，运行时门 = isPluginUiEnabled，
    // 单一权威源修复见 plans/plugin-visibility-plan.md）
    registerPluginDefaultUi(manifest.id, manifest.enabledByDefault)
    this.registerPanel(manifest)
    this.registerUiTemplates(manifest)
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
      registerPluginDefaultUi(registered.id, registered.enabledByDefault)
      this.registerPanel(registered)
      this.registerUiTemplates(registered)
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
        clearPluginDefaultUi(pluginId)
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
      registerPluginDefaultUi(registered.id, registered.enabledByDefault)
      this.registerPanel(registered)
      this.registerUiTemplates(registered)
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
    for (const view of views) {
      pluginPanelRegistry.register(
        view.panelType,
        manifest.id,
        createPanelLoader(manifest.installPath, panel.entry, manifest.id)
      )
    }

    // 浮层覆盖声明（plans/session-history-plugin-prd.md P0）：overlay 的
    // panelType 同样需要面板 loader（纯 overlay 插件可以没有 views）。
    for (const overlay of manifest.contributes.overlays ?? []) {
      pluginPanelRegistry.register(
        overlay.panelType,
        manifest.id,
        createPanelLoader(manifest.installPath, panel.entry, manifest.id)
      )
    }

    // H7：声明了 uiSlots 的插件预加载 entry，调用其 registerUi 注入工具栏/diff
    // 刷新等 UI 贡献。无面板视图但有 UI 贡献的插件也走这里（views 可以为空）。
    if ((manifest.contributes.uiSlots ?? []).length > 0) {
      const uiEnabled = isPluginUiEnabled(
        usePluginStore.getState().pluginStates,
        manifest.id,
      )
      if (uiEnabled) {
        void hydratePluginUi(manifest.id, manifest.installPath, panel.entry)
      }
    }
  }

  private registerUiTemplates(manifest: PolarisPluginManifest): void {
    const list = manifest.contributes.uiTemplates
    if (!list || list.length === 0) return
    for (const tpl of list) {
      // [R-12] 命名空间 + 保留名
      if (!tpl.id.startsWith(`${manifest.id}/`)) {
        log.warn('uiTemplates 注册被拒（id 未以插件 id 为命名空间）', { pluginId: manifest.id, id: tpl.id })
        continue
      }
      const reserved = ['ask-card', 'form-card', 'artifact-card', 'chart-card']
      const tail = tpl.id.slice(manifest.id.length + 1)
      if (reserved.includes(tail)) {
        log.warn('uiTemplates 注册被拒（保留模板名不可覆盖）', { pluginId: manifest.id, id: tpl.id })
        continue
      }
      uiTemplateRegistry.register(manifest.id, tpl)
    }
  }

  private registerChatCards(manifest: PolarisPluginManifest): void {
    const cards = manifest.contributes.chatCards
    if (!cards || cards.length === 0) return

    const ownMcpServerIds = new Set(
      (manifest.contributes.mcpServers ?? []).map((server) => server.id)
    )

    for (const card of cards) {
      // matchBy 卡片（block/tool 前缀 key）不绑定 MCP server，绕过归属校验。
      // 其 key 前缀（block:/tool:）与 MCP 路径（mcp__）互不冲突，插件仅能覆盖
      // 自己声明的块类型/工具名，无法劫持其他插件的 MCP 卡片。
      if (!card.matchBy && !ownMcpServerIds.has(card.mcpServerId ?? '')) {
        continue
      }

      if (card.entry && manifest.installPath) {
        chatCardRegistry.register(
          manifest.id,
          card,
          createChatCardLoader(manifest.installPath, card.entry, manifest.id)
        )
      }
    }
  }

  private registerEngines(manifest: PolarisPluginManifest): Promise<void> {
    const engines = manifest.contributes.engines
    // hook 订阅接线（P1.5）：与引擎同生命周期（启用注册 / 禁用注销）。
    // fire-and-forget：hook 注册失败不阻塞插件装载（后端 cap.hook 未装配时静默）。
    this.registerHooks(manifest)
    if (!engines || engines.length === 0) return Promise.resolve()

    // 记录引擎→插件映射
    this.recordEngineMapping(manifest)

    // 先注册所有引擎，再统一刷新 store
    return Promise.all(engines.map(e => this.registerSingleEngine(e, manifest.id)))
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

  private async registerSingleEngine(engine: PluginEngineContribution, pluginId: string): Promise<void> {
    // 读取插件 MCP 启用状态
    const mcpEnabled = usePluginStore.getState().isPluginMcpEnabled(pluginId)
    // 获取插件安装路径（用于解析适配器入口等相对路径）
    const manifest = this.manifests.get(pluginId)
    const installPath = manifest?.installPath
    // 引擎 CLI 路径同样支持 {{pluginDir}} 占位符（与 MCP argsTemplate / 执行器一致）。
    // 为什么必须替换：插件安装目录随数据根变化（dev/test/便携版各不相同），
    // 清单里写死绝对路径会让引擎在别的机器或换数据根后指回旧目录。
    const fillPluginDir = (value: string): string =>
      installPath ? value.split('{{pluginDir}}').join(installPath) : value
    const engineConfig = {
      id: engine.id,
      name: engine.name,
      description: engine.description,
      cli: {
        command: fillPluginDir(engine.cli.command),
        args: (engine.cli.args ?? []).map(fillPluginDir),
        installGuide: engine.cli.installGuide ?? '',
      },
      protocol: engine.protocol ?? 'pi-rpc',
      sessionFlags: engine.sessionFlags ?? 'pi',
      providerConfig: engine.providerConfig,
      npmPackage: engine.npmPackage,
      installUrl: engine.installUrl,
      mcpConsumption: engine.mcpConsumption ?? 'mcp-servers',
      mcpEnabled,
      capabilities: {
        tools: engine.capabilities?.tools ?? true,
        streaming: engine.capabilities?.streaming ?? true,
        interrupt: engine.capabilities?.interrupt ?? true,
        resume: engine.capabilities?.resume ?? true,
      },
      adapter: engine.adapter,
      installPath: installPath,
      models: engine.models ?? [],
      sessionConfig: engine.sessionConfig,
    }
    log.info(`[registerSingleEngine] engine.id=${engine.id}, hasAdapter=${!!engine.adapter}, installPath=${installPath}, mcpEnabled=${mcpEnabled}`)
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

  /** 重新注册插件的所有引擎（MCP 开关切换后调用） */
  async reRegisterPluginEngines(pluginId: string): Promise<void> {
    const manifest = this.manifests.get(pluginId)
    if (!manifest) {
      log.warn(`[reRegisterPluginEngines] 未找到插件: ${pluginId}`)
      return
    }
    const engines = manifest.contributes.engines
    if (!engines || engines.length === 0) return

    log.info(`[PluginRegistry] 重新注册插件引擎: ${pluginId}（MCP 状态变更）`)
    // 先卸载旧引擎，再重新注册
    await this.unregisterEngines(manifest)
    this.clearEngineMapping(pluginId)
    this.recordEngineMapping(manifest)
    await Promise.all(engines.map(e => this.registerSingleEngine(e, pluginId)))
    useEngineMetadataStore.getState().reload().catch(() => {})
  }

  private unregisterEngines(manifest: PolarisPluginManifest): Promise<void> {
    const engines = manifest.contributes.engines
    // hook 订阅注销（P1.5）：与引擎卸载同通道
    this.unregisterHooks(manifest)
    if (!engines || engines.length === 0) return Promise.resolve()

    return Promise.all(engines.map(e =>
      invoke('unregister_plugin_engine', { engineId: e.id }).catch(() => {})
    )).then(() => {
      useEngineMetadataStore.getState().reload().catch(() => {})
    })
  }

  /**
   * hook 订阅注册（P1.5，ai-chat-plugin-extraction-spec）。
   *
   * 把 manifest.contributes.hooks 逐条经 cap.hook.register 绑定回调 cap。
   * 走 router_dispatch（宿主桥白名单内），后端 HookSystem 幂等（同 hook+cap
   * 去重）。失败仅 warn 不阻塞——hook 是增强通道，不是插件功能的前提。
   */
  private registerHooks(manifest: PolarisPluginManifest): void {
    const hooks = manifest.contributes.hooks ?? []
    if (hooks.length === 0) return
    for (const hook of hooks) {
      invoke('router_dispatch', {
        req: {
          target: 'cap.hook',
          payload: { action: 'register', hookId: hook.id, capId: hook.capId, pluginId: manifest.id },
        },
      })
        .then((res) => {
          const r = res as { ok?: boolean; error?: string | null }
          if (r?.ok) {
            log.info(`[PluginRegistry] hook 已注册: ${hook.id} -> ${hook.capId} (${manifest.id})`)
          } else {
            log.warn(`[PluginRegistry] hook 注册被拒: ${hook.id} (${manifest.id}): ${r?.error ?? 'unknown'}`)
          }
        })
        .catch((err) => {
          log.warn(`[PluginRegistry] hook 注册失败: ${hook.id} (${manifest.id}):`, err)
        })
    }
  }

  /** hook 订阅注销（插件禁用/卸载/替换时；fire-and-forget，失败静默） */
  private unregisterHooks(manifest: PolarisPluginManifest): void {
    const hooks = manifest.contributes.hooks ?? []
    if (hooks.length === 0) return
    for (const hook of hooks) {
      invoke('router_dispatch', {
        req: {
          target: 'cap.hook',
          payload: { action: 'unregister', hookId: hook.id, capId: hook.capId },
        },
      }).catch(() => {})
    }
  }

  listPlugins(): PolarisPluginManifest[] {
    return Array.from(this.manifests.values())
  }

  /** 按 id 取插件 manifest（host 桥按调用方查 permissions 用，P1.3） */
  getPlugin(pluginId: string): PolarisPluginManifest | undefined {
    return this.manifests.get(pluginId)
  }

  listViewContributions(area: PluginViewArea): PluginViewContribution[] {
    return this.listPlugins()
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
      .flatMap((plugin) =>
        (plugin.contributes.chatCards ?? []).map((card) => ({
          ...card,
          pluginId: plugin.id,
        }))
      )
  }

  /**
   * 列出所有已启用插件的 toolProvider 贡献点。
   *
   * 每个 toolProvider 声明一个 capability（如 "shell"）和一个 mcpServerId，
   * 表示该插件要用自己的 MCP server 接管该能力。后端 MCP 配置解析时
   * 会用插件声明的 server 替换同 capability 的内置实现。
   */
  /**
   * 列出所有已注册插件的 cap 贡献点（P2-d）。
   * 仅展示清单数据；实际注册在宿主启动/插件生命周期同步时由后端完成。
   */
  listCapabilityContributions(): (PluginCapabilityContribution & { pluginId: string })[] {
    return this.listPlugins().flatMap((plugin) =>
      (plugin.contributes.capabilities ?? []).map((cap) => ({
        ...cap,
        pluginId: plugin.id,
      }))
    )
  }

  listToolProviderContributions(): (PluginToolProviderContribution & { pluginId: string })[] {
    return this.listPlugins()
      .flatMap((plugin) =>
        (plugin.contributes.toolProviders ?? []).map((provider) => ({
          ...provider,
          pluginId: plugin.id,
        }))
      )
  }

  /**
   * 查询某 slot 是否被插件 shadow 覆盖（P3-T1）。
   *
   * 如果返回非 undefined，表示有插件声明了 `slotMode: "shadow"` 覆盖该 slot，
   * 调用方应隐藏默认面板，改用插件面板。
   */
  getShadowedSlot(slotId: string): PluginViewContribution | undefined {
    return this.listViewContributions('activityBar')
      .find((v) => v.slot === slotId && v.slotMode === 'shadow')
  }

  /**
   * 查询某浮层插槽的接管声明（plans/session-history-plugin-prd.md P0）。
   *
   * 返回首个（order 升序）声明了 `contributes.overlays[].slot === slotId` 且
   * mode=shadow 的贡献。调用方（App.tsx 浮层挂载点）命中时渲染插件面板，
   * 未命中（无声明 / 插件禁用 / 卸载）时渲染宿主默认实现——天然回滚。
   *
   * 注意：启用状态复核（isPluginUiEnabled）由调用方做（本方法保持纯清单查询，
   * 与 listViewContributions 同语义）。
   */
  getOverlayClaim(slotId: string): PluginOverlayContribution & { pluginId: string } | undefined {
    return this.listPlugins()
      .flatMap((plugin) =>
        (plugin.contributes.overlays ?? [])
          .filter((o) => o.slot === slotId && (o.mode ?? 'shadow') === 'shadow')
          .map((o) => ({ ...o, pluginId: plugin.id })),
      )
      .sort((a, b) => {
        // order 取插件首个 view 的 order（无 view 的纯 overlay 插件排后）
        const orderOf = (pid: string) =>
          this.manifests.get(pid)?.contributes.views?.[0]?.order ?? 1000
        return orderOf(a.pluginId) - orderOf(b.pluginId)
      })[0]
  }

  /**
   * 查询主面板席位（mainSurface）的接管声明（ai-chat-plugin-extraction-spec P1.2）。
   *
   * 返回首个（order 升序）声明了 `area: 'mainSurface'` 的插件视图贡献。
   * 调用方（App.tsx 主内容区）命中且插件启用时渲染 PluginPanelHost，未命中
   * （无声明 / 插件禁用 / 卸载）时渲染宿主空态/内置面板——天然回滚。
   *
   * 注意：启用状态复核（isPluginUiEnabled）由调用方做（与 getOverlayClaim 同语义）。
   */
  getMainSurfaceClaim(): PluginViewContribution & { pluginId: string } | undefined {
    return this.listViewContributions('mainSurface')[0]
  }

  /**
   * 列出被 shadow 接管（且接管目标 view 仍存在）的插件 panelType 集合。
   *
   * 这些插件视图的内容已挂在被接管的内建席位下渲染（LeftPanel shadow 消费端），
   * 不应再出现独立入口。消费方：LeftPanelTabStrip（tab 条）、toolSwitcherData
   * （工具切换器图标列）、RadialMenu（径向菜单）——此前只有 tab 条做了折叠，
   * 工具切换器/径向菜单漏过滤，出现内置"终端"+插件"终端"两个入口
   * （2026-11-11 terminal-desk 交付实测）。
   *
   * 目标 view 被拆除（如内建席位移除）时接管声明找不到目标，插件视图自动
   * 恢复独立入口（自愈语义，与 LeftPanel 消费端一致）。
   */
  listShadowOwnPanelTypes(): Set<string> {
    const views = this.listViewContributions('activityBar')
    return new Set(
      views
        .filter((v) => v.slotMode === 'shadow' && v.slot)
        .filter((v) => views.some((t) => t.id === v.slot))
        .map((v) => v.panelType),
    )
  }

  /**
   * 查询某 slot 的所有 chain 增强插件（P3-T1）。
   *
   * 返回声明了 `slotMode: "chain"` 且 slot 匹配的所有插件视图，
   * 调用方可在默认面板渲染前后注入这些插件的内容。
   */
  getChainedSlots(slotId: string): PluginViewContribution[] {
    return this.listViewContributions('activityBar')
      .filter((v) => v.slot === slotId && v.slotMode === 'chain')
  }

  /**
   * 列出所有已启用插件的 styles 贡献点。
   */
  listStyleContributions(): (PluginStyleContribution & { pluginId: string })[] {
    return this.listPlugins()
      .flatMap((plugin) =>
        (plugin.contributes.styles ?? []).map((style) => ({
          ...style,
          pluginId: plugin.id,
        }))
      )
  }
}

export const pluginRegistry = new PluginRegistry()
