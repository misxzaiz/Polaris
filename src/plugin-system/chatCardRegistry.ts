/**
 * 聊天卡片渲染器注册表
 *
 * 按 MCP 工具完整名 `mcp__{server}__{tool}` 匹配 → 由插件自定义渲染。
 * 仿 panelRegistry：懒加载、缓存、按插件卸载清理。
 *
 * 注册时机：
 * - 外部插件：registry.registerChatCards 自动按 installPath + entry 注册 loader
 * - 内置插件：builtinPlugins.ts 手动 register(loader)，无 installPath
 *
 * 安全约束：调用方在 register 前必须校验 mcpServerId 归属（registry 与
 * pluginDiscoveryService 已做）。
 */

import type {
  PluginChatCardComponent,
  PluginChatCardContribution,
  PluginChatCardLoader,
} from './types'
import { createLogger } from '@/utils/logger'

const log = createLogger('ChatCardRegistry')

interface CardEntry {
  pluginId: string
  cardId: string
  mode: PluginChatCardContribution['mode']
  mcpServerId: string
  tools: string[]
  loader?: PluginChatCardLoader
}

/**
 * 注册表内部以 (mcpServerId, tool) 为 key，便于按完整工具名 O(1) 匹配。
 * 同时保留 pluginId → keys 的反向索引，用于按插件卸载。
 */
class ChatCardRegistry {
  /** key = `mcp__{server}__{tool}` */
  private cards = new Map<string, CardEntry>()
  /** 反向索引：pluginId → 该插件注册的全部 key */
  private pluginKeys = new Map<string, Set<string>>()
  /** 已加载组件缓存：key → component */
  private cache = new Map<string, PluginChatCardComponent>()

  register(
    pluginId: string,
    card: Omit<PluginChatCardContribution, 'pluginId'>,
    loader?: PluginChatCardLoader
  ): void {
    const keys = card.tools.map((tool) => this.buildKey(card.mcpServerId, tool))
    const entry: CardEntry = {
      pluginId,
      cardId: card.id,
      mode: card.mode,
      mcpServerId: card.mcpServerId,
      tools: card.tools,
      loader,
    }

    let keySet = this.pluginKeys.get(pluginId)
    if (!keySet) {
      keySet = new Set()
      this.pluginKeys.set(pluginId, keySet)
    }

    for (const key of keys) {
      const existing = this.cards.get(key)
      if (existing) {
        log.warn(
          `Card for "${key}" already registered by plugin ${existing.pluginId} (${existing.cardId}), overriding with ${pluginId} (${card.id})`
        )
        // 从旧插件的反向索引中移除
        const oldSet = this.pluginKeys.get(existing.pluginId)
        oldSet?.delete(key)
      }
      this.cards.set(key, entry)
      keySet.add(key)
      this.cache.delete(key)
    }

    log.debug(`Registered chat card: ${pluginId}/${card.id} for tools ${keys.join(', ')}`)
  }

  /**
   * 手动注册内置插件的卡片 loader（无 installPath）。
   */
  registerBuiltin(
    pluginId: string,
    card: Omit<PluginChatCardContribution, 'pluginId'>,
    loader: PluginChatCardLoader
  ): void {
    this.register(pluginId, card, loader)
  }

  unregisterAll(pluginId: string): void {
    const keys = this.pluginKeys.get(pluginId)
    if (!keys) return
    for (const key of keys) {
      this.cards.delete(key)
      this.cache.delete(key)
    }
    this.pluginKeys.delete(pluginId)
    log.debug(`Unregistered all chat cards for plugin ${pluginId}`)
  }

  /**
   * 按完整工具名匹配卡片。返回 entry 或 undefined（调用方回落到默认渲染）。
   */
  match(toolName: string): CardEntry | undefined {
    return this.cards.get(toolName)
  }

  /**
   * 懒加载卡片组件。loader 缺失或加载失败时抛错，由调用方（PluginCardHost）捕获后回落。
   */
  async load(toolName: string): Promise<PluginChatCardComponent> {
    const cached = this.cache.get(toolName)
    if (cached) return cached

    const entry = this.cards.get(toolName)
    if (!entry) {
      throw new Error(`No chat card registered for tool: ${toolName}`)
    }
    if (!entry.loader) {
      throw new Error(`Chat card "${entry.cardId}" has no loader (plugin ${entry.pluginId})`)
    }

    const mod = await entry.loader()
    const component = mod.default
    if (!component) {
      throw new Error(
        `Chat card module for "${toolName}" does not export a default component`
      )
    }

    this.cache.set(toolName, component)
    return component
  }

  /**
   * 列出全部已注册的匹配 key（调试/校验用）。
   */
  listKeys(): string[] {
    return Array.from(this.cards.keys())
  }

  private buildKey(mcpServerId: string, tool: string): string {
    return `mcp__${mcpServerId}__${tool}`
  }
}

export const chatCardRegistry = new ChatCardRegistry()
