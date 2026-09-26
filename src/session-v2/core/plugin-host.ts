/**
 * InMemoryPluginHost — 层 1 验证用的插件宿主实现
 *
 * 借鉴 Minecraft 模组加载三阶段：
 * - register：插件注册（可声明依赖）
 * - wire：按依赖拓扑排序，插件拿到上下文
 * - run：hook 开始生效，按注册顺序依次调用
 *
 * 验证目标：4 个 hook（beforeCreateSession / beforeAppendMessage /
 * onSessionStatusChange / beforeRequestStart）能否覆盖 6 类触发场景。
 */

import type {
  LoadPhase,
  SessionPlugin,
  PluginContext,
  PluginHost,
  BeforeCreateSessionHook,
  BeforeAppendMessageHook,
  OnSessionStatusChangeHook,
  BeforeRequestStartHook,
  SessionRecord,
  MessageEntry,
  SessionStatus,
} from './types'

export class InMemoryPluginHost implements PluginHost {
  private plugins = new Map<string, SessionPlugin>()
  private sorted: SessionPlugin[] = []
  private _phase: LoadPhase = 'register'

  constructor(private context: PluginContext) {}

  get phase(): LoadPhase {
    return this._phase
  }

  register(plugin: SessionPlugin): void {
    if (this._phase !== 'register') {
      throw new Error(
        `register 阶段已结束（当前 ${this._phase}），禁止注册插件 ${plugin.id}`,
      )
    }
    if (this.plugins.has(plugin.id)) {
      throw new Error(`插件重复注册: ${plugin.id}`)
    }
    this.plugins.set(plugin.id, plugin)
    this.sorted = []
  }

  advancePhase(): void {
    if (this._phase === 'register') {
      this.sortPlugins()
      this._phase = 'wire'
    } else if (this._phase === 'wire') {
      this._phase = 'run'
    } else {
      throw new Error(`已是最终加载阶段 ${this._phase}`)
    }
  }

  listPlugins(): SessionPlugin[] {
    return [...this.sorted]
  }

  /** 测试辅助：当前插件数量 */
  get size(): number {
    return this.sorted.length
  }

  // ==========================================================================
  // Hook 分发（run 阶段使用）
  // ==========================================================================

  /**
   * 分发 beforeCreateSession：按注册顺序调用，
   * 任一插件返回 null 则阻止创建，返回修改后的 record 则传递给下一个插件。
   */
  async dispatchBeforeCreateSession(
    record: Omit<SessionRecord, 'version' | 'createdAt' | 'updatedAt'>,
  ): Promise<Omit<SessionRecord, 'version' | 'createdAt' | 'updatedAt'> | null> {
    if (this._phase !== 'run') {
      throw new Error(`插件未就绪：当前阶段 ${this._phase}，需要 run`)
    }
    let current = record
    for (const plugin of this.sorted) {
      const hook = plugin.beforeCreateSession as BeforeCreateSessionHook | undefined
      if (!hook) continue
      const result = await hook(current)
      if (result === null) return null
      current = result
    }
    return current
  }

  /**
   * 分发 beforeAppendMessage：任一插件返回 null 则阻止追加。
   */
  async dispatchBeforeAppendMessage(entry: MessageEntry): Promise<MessageEntry | null> {
    if (this._phase !== 'run') {
      throw new Error(`插件未就绪：当前阶段 ${this._phase}，需要 run`)
    }
    let current = entry
    for (const plugin of this.sorted) {
      const hook = plugin.beforeAppendMessage as BeforeAppendMessageHook | undefined
      if (!hook) continue
      const result = await hook(current)
      if (result === null) return null
      current = result
    }
    return current
  }

  /**
   * 分发 onSessionStatusChange：会话状态变化通知所有订阅插件。
   */
  async dispatchOnSessionStatusChange(
    conversationId: string,
    old: SessionStatus,
    next: SessionStatus,
  ): Promise<void> {
    if (this._phase !== 'run') return
    for (const plugin of this.sorted) {
      const hook = plugin.onSessionStatusChange as OnSessionStatusChangeHook | undefined
      if (!hook) continue
      await hook(conversationId, old, next)
    }
  }

  /**
   * 分发 beforeRequestStart：任一插件返回 false 则拒绝本次启动请求。
   */
  async dispatchBeforeRequestStart(
    conversationId: string,
    deviceId: string,
  ): Promise<boolean> {
    if (this._phase !== 'run') return true
    for (const plugin of this.sorted) {
      const hook = plugin.beforeRequestStart as BeforeRequestStartHook | undefined
      if (!hook) continue
      if (!(await hook(conversationId, deviceId))) return false
    }
    return true
  }

  /** 测试辅助：获取已注册插件（保持注册顺序） */
  getPlugin(id: string): SessionPlugin | undefined {
    return this.plugins.get(id)
  }

  /** 测试辅助：插件上下文 */
  getContext(): PluginContext {
    return this.context
  }

  // ==========================================================================
  // 拓扑排序（wire 阶段执行）
  // ==========================================================================

  private sortPlugins(): void {
    const visited = new Set<string>()
    const result: SessionPlugin[] = []
    const visit = (id: string, stack: Set<string>) => {
      if (visited.has(id)) return
      if (stack.has(id)) {
        throw new Error(`插件依赖成环: ${[...stack, id].join(' -> ')}`)
      }
      const plugin = this.plugins.get(id)
      if (!plugin) {
        throw new Error(`依赖的插件不存在: ${id}`)
      }
      stack.add(id)
      for (const dep of plugin.dependencies ?? []) {
        visit(dep, stack)
      }
      stack.delete(id)
      visited.add(id)
      result.push(plugin)
    }
    for (const id of this.plugins.keys()) {
      visit(id, new Set())
    }
    this.sorted = result
  }
}
