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
import { buildMcpToolName } from '@/utils/toolConfig'

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

  // opencode 引擎用 Code Mode 调 MCP：模型在一个 execute 工具里写 JS
  // `tools["server"].tool(...)`，tool_call 事件只看到载体工具名（execute/xecute），
  // 直接按名匹配必然 miss → 需从 block.input.code 提取内嵌 MCP 调用再匹配。
  private static CODE_MODE_TOOL_RE = /^(?:e?xecute)$/i
  private static MCP_INVOCATION_RE =
    /\btools\[\s*["']([^"']+)["']\s*\]\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g
  /** return 语句显式返回某次 MCP 调用 → execute 返回值即该工具的结果（卡片 data 同源） */
  private static RETURN_MCP_RE =
    /\breturn\b[^;]{0,200}?\btools\[\s*["']([^"']+)["']\s*\]\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/

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
   * 解析一次工具调用应使用的卡片（含 opencode Code Mode 适配），并返回命中 key。
   *
   * - toolName 直接命中注册表 → key = toolName（Claude Code 等引擎的原生 MCP 工具路径）。
   * - toolName 是 Code Mode 载体（execute/xecute）且未直接命中 → 从 block.input.code
   *   提取内嵌 `tools["server"].tool(...)` 调用并按完整名再查注册表。
   *   多个调用时优先 return 语句所指的那次（execute 返回值与其卡片 data 同源）。
   */
  resolveWithKey(toolName: string, blockInput: unknown): { entry: CardEntry; key: string } | undefined {
    const direct = this.match(toolName)
    if (direct) return { entry: direct, key: toolName }
    if (!ChatCardRegistry.CODE_MODE_TOOL_RE.test(toolName)) return undefined
    const code =
      typeof blockInput === 'object' && blockInput !== null
        ? (blockInput as { code?: unknown }).code
        : undefined
    if (typeof code !== 'string') return undefined

    const invocations: Array<{ server: string; tool: string }> = []
    for (const m of code.matchAll(ChatCardRegistry.MCP_INVOCATION_RE)) {
      const [server, tool] = [m[1], m[2]]
      if (this.cards.has(buildMcpToolName(server, tool))) invocations.push({ server, tool })
    }
    if (invocations.length === 0) return undefined
    if (invocations.length === 1) {
      const key = buildMcpToolName(invocations[0].server, invocations[0].tool)
      const entry = this.match(key)
      return entry ? { entry, key } : undefined
    }

    // 多命中：优先 return 语句指针对齐；否则取首个命中（best-effort）
    const returnMatch = ChatCardRegistry.RETURN_MCP_RE.exec(code)
    if (returnMatch) {
      const returnKey = `${returnMatch[1]}__${returnMatch[2]}`
      const preferred = invocations.find((v) => `${v.server}__${v.tool}` === returnKey)
      if (preferred) {
        const key = buildMcpToolName(preferred.server, preferred.tool)
        const entry = this.match(key)
        return entry ? { entry, key } : undefined
      }
    }
    const key = buildMcpToolName(invocations[0].server, invocations[0].tool)
    const entry = this.match(key)
    return entry ? { entry, key } : undefined
  }

  /**
   * resolve 的薄包装（保留既有调用方/测试口径）：返回命中 entry，不含 key。
   */
  resolve(toolName: string, blockInput: unknown): CardEntry | undefined {
    return this.resolveWithKey(toolName, blockInput)?.entry
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
    return buildMcpToolName(mcpServerId, tool)
  }
}

export const chatCardRegistry = new ChatCardRegistry()
