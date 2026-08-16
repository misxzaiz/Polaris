/**
 * CordisHost — Polaris 内的 Cordis 运行时宿主
 *
 * 管理一个 Cordis Context 实例，负责加载/卸载 DSH 插件。
 * 每个安装的 DSH 插件在此 Context 中挂载并管理生命周期。
 *
 * Cordis 5 大核心机制：
 * 1. Context — 服务仓库，ctx.<key> 找服务
 * 2. 可逆效应 — ctx.effect() 注册，disposer 回滚
 * 3. 事件总线 — ctx.on/emit/parallel/serial/waterfall
 * 4. 依赖注入 — inject 声明，ctx.inject 延迟激活
 * 5. 插件系统 — plugin(name/inject/apply) 加载
 */

import { Context } from '@deepseek-ai/cordis'
import { PolarisToolBridge } from './bridges/tools'
import { PolarisSystemPromptBridge } from './bridges/systemPrompt'
import { PolarisScopeBridge } from './bridges/scope'
import { createLogger } from '@/utils/logger'

const log = createLogger('CordisHost')

export interface DshPluginManifest {
  /** 插件 npm 包名 */
  packageName: string
  /** 安装路径 */
  installPath: string
  /** 插件 id（从 name 推导） */
  id: string
  /** 依赖就绪状态 */
  status: 'pending' | 'ready' | 'error'
  /** 缺失的依赖列表 */
  missingDeps: string[]
  /** 错误信息 */
  error?: string
}

export class CordisHost {
  private ctx: Context
  private loadedPlugins = new Map<string, { dispose: () => void; manifest: DshPluginManifest }>()

  constructor() {
    this.ctx = new Context()
    this.registerPolarisServices()
    log.info('CordisHost 初始化完成')
  }

  /** 注册 Polaris 实现的 DSH 服务接口 */
  private registerPolarisServices(): void {
    // ctx.tools → Polaris ToolRegistry + McpClientPool
    this.ctx.provide('tools', new PolarisToolBridge())

    // ctx.systemPrompt → Polaris 系统提示词构建
    this.ctx.provide('systemPrompt', new PolarisSystemPromptBridge())

    // ctx.scope → Cordis scope 基础实现
    this.ctx.provide('scope', new PolarisScopeBridge())

    // ctx.invariants → 错误检查基础设施（stub）
    this.ctx.provide('invariants', {
      check: (condition: boolean, message: string) => {
        if (!condition) throw new Error(`[invariant] ${message}`)
        return condition as true
      },
    })

    log.info('CordisHost 服务注册完成')
  }

  /**
   * 加载一个 DSH 插件模块。
   *
   * 动态 import() 插件模块，调用其 `apply(ctx)`。
   * 插件的 `inject` 声明决定依赖是否就绪。
   */
  async loadPlugin(modulePath: string, packageName?: string): Promise<DshPluginManifest> {
    try {
      const mod = await import(modulePath)

      // 获取插件元数据
      const pluginName = mod.name ?? packageName ?? modulePath
      const inject = mod.inject ?? []
      const apply = mod.apply ?? mod.default?.apply

      if (typeof apply !== 'function') {
        throw new Error(`DSH 插件 ${pluginName} 没有导出 apply 函数`)
      }

      // 检查依赖是否就绪
      const missingDeps = this.checkDependencies(inject)

      // 用 ctx.effect() 挂载插件（可逆注册）
      const disposer = this.ctx.effect(() => {
        apply(this.ctx)
        log.info(`DSH 插件已挂载: ${pluginName}`)
        return () => {
          log.info(`DSH 插件已卸载: ${pluginName}`)
        }
      })

      const manifest: DshPluginManifest = {
        packageName: packageName ?? pluginName,
        installPath: modulePath,
        id: pluginName,
        status: missingDeps.length > 0 ? 'pending' : 'ready',
        missingDeps,
      }

      this.loadedPlugins.set(pluginName, { dispose: disposer, manifest })
      log.info(`DSH 插件加载完成: ${pluginName}`, { status: manifest.status, missingDeps })
      return manifest
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error(`DSH 插件加载失败: ${modulePath} — ${msg}`)
      return {
        packageName: packageName ?? modulePath,
        installPath: modulePath,
        id: modulePath,
        status: 'error',
        missingDeps: [],
        error: msg,
      }
    }
  }

  /** 卸载 DSH 插件（触发可逆效应自动清理） */
  unloadPlugin(pluginId: string): boolean {
    const plugin = this.loadedPlugins.get(pluginId)
    if (plugin) {
      plugin.dispose()
      this.loadedPlugins.delete(pluginId)
      log.info(`DSH 插件已卸载: ${pluginId}`)
      return true
    }
    return false
  }

  /** 检查 inject 依赖是否全部就绪 */
  private checkDependencies(inject: string[]): string[] {
    const missing: string[] = []
    for (const key of inject) {
      try {
        this.ctx.get(key as any)
      } catch {
        missing.push(key)
      }
    }
    return missing
  }

  /** 获取所有已加载的 DSH 插件 */
  getLoadedPlugins(): DshPluginManifest[] {
    return Array.from(this.loadedPlugins.values()).map((p) => p.manifest)
  }

  /** 获取 Cordis 根 Context（供调试/自省） */
  getContext(): Context {
    return this.ctx
  }
}

/** 全局单例 */
export const cordisHost = new CordisHost()