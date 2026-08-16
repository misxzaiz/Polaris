/**
 * DSH 服务接口类型声明
 *
 * 为 Cordis Context 类型合并 DSH 服务接口的声明。
 * DSH 插件通过 `declare module '@deepseek-ai/cordis'` 扩展 Context 接口，
 * 这里提供 Polaris 已桥接的服务接口类型。
 */

import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  export interface Context {
    /** 工具注册表（由 PolarisToolBridge 实现） */
    tools: {
      register(tool: any, options?: { disposer?: () => void }): void
      unregister(name: string): void
      get(name: string): any | undefined
    }

    /** 系统提示词（由 PolarisSystemPromptBridge 实现） */
    systemPrompt: {
      section(key: string, content: string, options?: { order?: number }): void
      remove(key: string): void
      getSections(): string[]
    }

    /** 作用域（由 PolarisScopeBridge 实现） */
    scope: {
      get(key: string): any | undefined
      set(key: string, value: any): void
      delete(key: string): void
    }

    /** 不变量检查（stub 实现） */
    invariants: {
      check(condition: boolean, message: string): true
    }
  }
}