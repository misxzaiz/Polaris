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
}
