/**
 * 插件服务管理器（前端门面）
 *
 * 通过 Tauri IPC 调用后端 plugin_service_* 命令。
 * 后端负责真实的进程拉起 / 健康检查 / 自动重启。
 */

import { invoke } from '@/services/transport'
import type {
  PluginId,
  PluginServiceContribution,
  PluginServiceStatus,
} from '@/plugin-system/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginServiceManager')

type RawContribution = Omit<PluginServiceContribution, 'pluginId'>

/**
 * 懒激活去重 Map：`${pluginId}:${serviceId}` -> 进行中的启动 Promise。
 * 防止并发调用对同一服务重复拉起进程。Promise settle 后自动清理条目。
 *
 * 供 ensureServiceRunning 使用：并发场景下第二个调用方复用同一个 Promise，
 * 避免对同一插件服务发起重复的 plugin_service_start IPC（重复拉起进程）。
 */
const ensureInflight = new Map<string, Promise<PluginServiceStatus>>()

/** 把前端 contribution（camelCase）转换成后端期望的 manifest contribution
 *  PluginServiceManifestContribution 的 Rust 端字段是 `type`，serde 的 rename 已经把
 *  内部 `service_type` 别名为 `type`，因此这里直接传 `type` 即可。
 */
function toBackendContribution(c: RawContribution): Record<string, unknown> {
  return {
    id: c.id,
    type: c.type,
    command: c.command,
    argsTemplate: c.argsTemplate ?? [],
    port: c.port ?? null,
    healthCheck: c.healthCheck ?? null,
    healthCheckTimeout: c.healthCheckTimeout ?? null,
    autoStart: c.autoStart ?? true,
    restartOnFailure: c.restartOnFailure ?? true,
    maxRestarts: c.maxRestarts ?? 3,
    description: c.description ?? null,
  }
}

export const pluginServiceManager = {
  async startService(
    pluginId: PluginId,
    contribution: RawContribution,
    installPath: string,
    workspacePath?: string,
  ): Promise<PluginServiceStatus> {
    log.info('Starting plugin service', { pluginId, serviceId: contribution.id })
    return invoke<PluginServiceStatus>('plugin_service_start', {
      pluginId,
      installPath,
      contribution: toBackendContribution(contribution),
      workspacePath: workspacePath ?? null,
    })
  },

  async stopService(pluginId: PluginId, serviceId: string): Promise<PluginServiceStatus> {
    log.info('Stopping plugin service', { pluginId, serviceId })
    return invoke<PluginServiceStatus>('plugin_service_stop', { pluginId, serviceId })
  },

  async restartService(pluginId: PluginId, serviceId: string): Promise<PluginServiceStatus> {
    log.info('Restarting plugin service', { pluginId, serviceId })
    return invoke<PluginServiceStatus>('plugin_service_restart', { pluginId, serviceId })
  },

  async listStatus(): Promise<PluginServiceStatus[]> {
    return invoke<PluginServiceStatus[]>('plugin_service_list_status')
  },

  async stopServicesForPlugin(pluginId: PluginId): Promise<PluginServiceStatus[]> {
    log.info('Stopping all services for plugin', { pluginId })
    return invoke<PluginServiceStatus[]>('plugin_service_stop_for_plugin', { pluginId })
  },

  /** 应用启动或插件状态批量变更时调用 */
  async autoStartAll(
    pluginStates: Record<string, { enabled: boolean }>,
    workspacePath?: string,
  ): Promise<PluginServiceStatus[]> {
    log.info('Auto-starting all plugin services', {
      pluginCount: Object.keys(pluginStates).length,
    })
    return invoke<PluginServiceStatus[]>('plugin_service_autostart', {
      pluginStates,
      workspacePath: workspacePath ?? null,
    })
  },

  /**
   * 懒激活：确保插件服务在运行（performance.pluginAutoStart=false 场景）。
   *
   * 调用流程：
   * 1. 复用进行中的启动 Promise（并发去重）
   * 2. 查当前状态：已 running/starting → 直接返回，不重复启动
   * 3. 否则发起 startService，存入去重 Map，完成后清理
   */
  async ensureServiceRunning(
    pluginId: PluginId,
    serviceId: string,
    contribution: RawContribution,
    installPath: string,
    workspacePath?: string,
  ): Promise<PluginServiceStatus> {
    const key = `${pluginId}:${serviceId}`

    // 1. 复用进行中的启动 Promise（并发去重）。
    //    get→set 发生在同步段：IIFE 创建 promise 是同步的，立即 set 进 map，
    //    JS 单线程事件循环保证并发调用第二个 get 到已 set 的 promise。
    const inflight = ensureInflight.get(key)
    if (inflight) return inflight

    const p = (async () => {
      // 2. 查当前是否已运行（避免对已运行服务重复 start）
      try {
        const statuses = await this.listStatus()
        const running = statuses.find(
          (s) => s.pluginId === pluginId && s.serviceId === serviceId && s.state === 'running',
        )
        if (running) return running
        const starting = statuses.find(
          (s) => s.pluginId === pluginId && s.serviceId === serviceId && s.state === 'starting',
        )
        if (starting) return starting
      } catch (e) {
        log.warn('ensureServiceRunning: 查询服务状态失败，继续尝试启动', {
          pluginId,
          serviceId,
          error: String(e),
        })
      }
      // 3. 发起启动
      return this.startService(pluginId, contribution, installPath, workspacePath)
    })().finally(() => {
      // 4. 完成后清理去重条目（防止内存泄漏），下次可重新启动
      ensureInflight.delete(key)
    })

    ensureInflight.set(key, p)
    return p
  },
}