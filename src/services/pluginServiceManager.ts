/**
 * 插件服务管理器（前端门面）
 *
 * 第七步阶段 C：插件服务管理上总线（router_dispatch → cap.pluginServiceManager）。
 * 业务函数签名保持与旧命令层 invoke 一致（消费方零改动），内部改走 RouterBus dispatch，
 * 获得统一权限 gate + 审计。
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

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
interface DispatchResponse {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

/**
 * 经 RouterBus dispatch 调用 cap.pluginServiceManager。
 * payload 需携带 action + 业务参数（与 capability invoke 的 `{ action, ... }` 对齐）。
 */
async function dispatchPluginServiceManager(
  action: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await invoke<DispatchResponse>('router_dispatch', {
    req: {
      target: 'cap.pluginServiceManager',
      payload: {
        action,
        ...payload,
      },
    },
  })

  if (!res.ok) {
    throw new Error(res.error || `cap.pluginServiceManager ${action} 失败`)
  }
  return res.result || {}
}

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
    return (await dispatchPluginServiceManager('start', {
      pluginId,
      installPath,
      contribution: toBackendContribution(contribution),
      workspacePath: workspacePath ?? null,
    })) as unknown as PluginServiceStatus
  },

  async stopService(pluginId: PluginId, serviceId: string): Promise<PluginServiceStatus> {
    log.info('Stopping plugin service', { pluginId, serviceId })
    return (await dispatchPluginServiceManager('stop', { pluginId, serviceId })) as unknown as PluginServiceStatus
  },

  async restartService(pluginId: PluginId, serviceId: string): Promise<PluginServiceStatus> {
    log.info('Restarting plugin service', { pluginId, serviceId })
    return (await dispatchPluginServiceManager('restart', { pluginId, serviceId })) as unknown as PluginServiceStatus
  },

  async listStatus(): Promise<PluginServiceStatus[]> {
    return (await dispatchPluginServiceManager('list_status', {})) as unknown as PluginServiceStatus[]
  },

  async stopServicesForPlugin(pluginId: PluginId): Promise<PluginServiceStatus[]> {
    log.info('Stopping all services for plugin', { pluginId })
    return (await dispatchPluginServiceManager('stop_for_plugin', { pluginId })) as unknown as PluginServiceStatus[]
  },

  /** 应用启动或插件状态批量变更时调用 */
  async autoStartAll(
    pluginStates: Record<string, { enabled: boolean }>,
    workspacePath?: string,
  ): Promise<PluginServiceStatus[]> {
    log.info('Auto-starting all plugin services', {
      pluginCount: Object.keys(pluginStates).length,
    })
    return (await dispatchPluginServiceManager('autostart', {
      pluginStates,
      workspacePath: workspacePath ?? null,
    })) as unknown as PluginServiceStatus[]
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