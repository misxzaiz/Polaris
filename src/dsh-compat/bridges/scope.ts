/**
 * PolarisScopeBridge — 桥接 DSH ctx.scope
 *
 * Cordis scope 基础实现，用于插件声明作用域隔离。
 * 当前为最小实现，只提供基础 scope 注册/查询。
 */

export class PolarisScopeBridge {
  private scopes = new Map<string, any>()

  get(key: string): any | undefined {
    return this.scopes.get(key)
  }

  set(key: string, value: any): void {
    this.scopes.set(key, value)
  }

  delete(key: string): void {
    this.scopes.delete(key)
  }
}