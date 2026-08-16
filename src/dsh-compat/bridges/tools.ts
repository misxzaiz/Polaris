/**
 * PolarisToolBridge — 桥接 DSH ctx.tools 到 Polaris ToolRegistry
 *
 * DSH 插件的 ctx.tools.register() 调用 → Polaris 的 McpClientPool / ToolRegistry。
 * 当前为最小实现，只支持 register/unregister/get。
 */

import { pluginRegistry } from '@/plugin-system/registry'

export class PolarisToolBridge {
  private tools = new Map<string, any>()

  register(tool: any, _options?: { disposer?: () => void }): void {
    const name = tool.name ?? tool.function?.name
    if (!name) {
      throw new Error('[PolarisToolBridge] 工具定义缺少 name')
    }
    this.tools.set(name, tool)
    // 未来：桥接到 Polaris 的 McpClientPool 或 ToolRegistry
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  get(name: string): any | undefined {
    return this.tools.get(name) ?? pluginRegistry.listToolProviderContributions().find(p => p.capability === name)
  }

  /** 所有已注册工具的 schema 列表 */
  list(): any[] {
    return Array.from(this.tools.values())
  }
}