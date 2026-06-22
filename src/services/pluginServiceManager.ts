/**
 * 插件服务管理器
 *
 * 管理插件声明的后台服务的完整生命周期：
 * - 启动/停止/重启服务
 * - 健康检查
 * - 自动重启
 * - 端口分配
 */

import type {
  PluginId,
  PluginServiceContribution,
  PluginServiceStatus,
} from '@/plugin-system/types'
import { pluginRegistry } from '@/plugin-system/registry'
import { isPluginMcpEnabled, type PluginStateMap } from '@/stores/pluginStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginServiceManager')

export interface ManagedService {
  contribution: PluginServiceContribution & { pluginId: PluginId }
  process?: ChildProcess
  status: PluginServiceStatus
  restartTimer?: ReturnType<typeof setTimeout>
  healthCheckTimer?: ReturnType<typeof setInterval>
}

interface ChildProcess {
  pid: number
  kill: () => void
}

// 端口分配范围
const PORT_RANGE_START = 10000
const PORT_RANGE_END = 60000

// 全局端口跟踪
const allocatedPorts = new Set<number>()

class PluginServiceManager {
  private services = new Map<string, ManagedService>()
  private portCounter = PORT_RANGE_START

  /**
   * 根据插件状态启动所有需要的服务
   */
  async startServicesForPlugins(pluginStates: PluginStateMap): Promise<void> {
    const plugins = pluginRegistry.listPlugins()

    for (const plugin of plugins) {
      if (!isPluginMcpEnabled(pluginStates, plugin.id)) {
        continue
      }

      const services = plugin.contributes.services ?? []
      for (const service of services) {
        if (service.autoStart !== false) {
          await this.startService(plugin.id, service)
        }
      }
    }
  }

  /**
   * 停止指定插件的所有服务
   */
  async stopServicesForPlugin(pluginId: PluginId): Promise<void> {
    const servicesToStop = Array.from(this.services.values()).filter(
      (s) => s.contribution.pluginId === pluginId
    )

    for (const service of servicesToStop) {
      await this.stopService(service.contribution.pluginId, service.contribution.id)
    }
  }

  /**
   * 启动单个服务
   */
  async startService(
    pluginId: PluginId,
    contribution: Omit<PluginServiceContribution, 'pluginId'>
  ): Promise<PluginServiceStatus> {
    const serviceKey = this.getServiceKey(pluginId, contribution.id)

    // 如果服务已在运行，直接返回状态
    const existing = this.services.get(serviceKey)
    if (existing && existing.status.state === 'running') {
      return existing.status
    }

    // 分配端口
    const port = contribution.port ?? this.allocatePort()

    log.info(`Starting service ${contribution.id} for plugin ${pluginId}`, { port })

    // 构建启动参数
    const args = this.buildArgs(contribution, port)

    // 创建托管服务记录
    const managed: ManagedService = {
      contribution: { ...contribution, pluginId },
      status: {
        serviceId: contribution.id,
        pluginId,
        state: 'starting',
        port,
        restartCount: 0,
      },
    }

    this.services.set(serviceKey, managed)

    try {
      // 启动进程（实际实现需要通过 Tauri 后端）
      // 这里是前端的模拟实现，实际需要调用后端 IPC
      const process = await this.spawnProcess(contribution.command, args)
      managed.process = process
      managed.status.state = 'running'
      managed.status.pid = process.pid

      // 启动健康检查
      if (contribution.healthCheck) {
        this.startHealthCheck(managed)
      }

      log.info(`Service ${contribution.id} started`, { pid: process.pid, port })
    } catch (error) {
      managed.status.state = 'error'
      managed.status.lastError = error instanceof Error ? error.message : String(error)
      log.error(`Failed to start service ${contribution.id}`, error as Error)

      // 尝试重启
      if (contribution.restartOnFailure !== false) {
        this.scheduleRestart(managed)
      }
    }

    return managed.status
  }

  /**
   * 停止单个服务
   */
  async stopService(pluginId: PluginId, serviceId: string): Promise<PluginServiceStatus> {
    const serviceKey = this.getServiceKey(pluginId, serviceId)
    const managed = this.services.get(serviceKey)

    if (!managed) {
      return {
        serviceId,
        pluginId,
        state: 'stopped',
        restartCount: 0,
      }
    }

    // 清理定时器
    if (managed.restartTimer) {
      clearTimeout(managed.restartTimer)
    }
    if (managed.healthCheckTimer) {
      clearInterval(managed.healthCheckTimer)
    }

    // 停止进程
    if (managed.process) {
      managed.status.state = 'stopping'
      managed.process.kill()
      managed.process = undefined
    }

    managed.status.state = 'stopped'
    managed.status.uptime = undefined

    // 释放端口
    if (managed.status.port) {
      allocatedPorts.delete(managed.status.port)
    }

    log.info(`Service ${serviceId} stopped`)
    return managed.status
  }

  /**
   * 重启服务
   */
  async restartService(pluginId: PluginId, serviceId: string): Promise<PluginServiceStatus> {
    await this.stopService(pluginId, serviceId)

    const serviceKey = this.getServiceKey(pluginId, serviceId)
    const managed = this.services.get(serviceKey)

    if (managed) {
      return this.startService(pluginId, managed.contribution)
    }

    return {
      serviceId,
      pluginId,
      state: 'stopped',
      restartCount: 0,
    }
  }

  /**
   * 获取服务状态
   */
  getServiceStatus(pluginId: PluginId, serviceId: string): PluginServiceStatus | undefined {
    const serviceKey = this.getServiceKey(pluginId, serviceId)
    return this.services.get(serviceKey)?.status
  }

  /**
   * 获取指定插件的所有服务状态
   */
  getPluginServiceStatuses(pluginId: PluginId): PluginServiceStatus[] {
    return Array.from(this.services.values())
      .filter((s) => s.contribution.pluginId === pluginId)
      .map((s) => s.status)
  }

  /**
   * 获取所有服务状态
   */
  getAllServiceStatuses(): PluginServiceStatus[] {
    return Array.from(this.services.values()).map((s) => s.status)
  }

  /**
   * 停止所有服务
   */
  async stopAll(): Promise<void> {
    for (const [, managed] of this.services) {
      await this.stopService(managed.contribution.pluginId, managed.contribution.id)
    }
  }

  // === 内部方法 ===

  private getServiceKey(pluginId: PluginId, serviceId: string): string {
    return `${pluginId}::${serviceId}`
  }

  private allocatePort(): number {
    while (allocatedPorts.has(this.portCounter)) {
      this.portCounter++
      if (this.portCounter >= PORT_RANGE_END) {
        this.portCounter = PORT_RANGE_START
      }
    }

    const port = this.portCounter
    allocatedPorts.add(port)
    this.portCounter++

    if (this.portCounter >= PORT_RANGE_END) {
      this.portCounter = PORT_RANGE_START
    }

    return port
  }

  private buildArgs(contribution: Omit<PluginServiceContribution, 'pluginId'>, port: number): string[] {
    const args = contribution.argsTemplate ?? []

    return args.map((arg) =>
      arg
        .replace(/\{\{port\}\}/g, String(port))
        .replace(/\{\{serviceId\}\}/g, contribution.id)
        .replace(/\{\{pluginDir\}\}/g, '{{pluginDir}}') // 实际值由后端填充
        .replace(/\{\{workspacePath\}\}/g, '{{workspacePath}}')
        .replace(/\{\{appConfigDir\}\}/g, '{{appConfigDir}}')
    )
  }

  private async spawnProcess(_command: string, _args: string[]): Promise<ChildProcess> {
    // 实际实现需要通过 Tauri IPC 调用后端
    // 这里返回一个模拟对象
    // 实际代码：
    // return await invoke('plugin_service_start', { command, args })

    // 模拟实现
    return {
      pid: Math.floor(Math.random() * 10000),
      kill: () => {
        log.debug('Process killed (simulated)')
      },
    }
  }

  private startHealthCheck(managed: ManagedService): void {
    const { contribution } = managed
    const timeout = contribution.healthCheckTimeout ?? 5000

    managed.healthCheckTimer = setInterval(() => {
      try {
        // 实际实现需要通过 HTTP 请求或 IPC 调用后端
        // 这里是模拟实现
        log.debug(`Health check for ${contribution.id}`)
      } catch (error) {
        log.warn(`Health check failed for ${contribution.id}`, { error: String(error) })
        managed.status.lastError = 'Health check failed'

        // 如果服务仍在运行但健康检查失败，尝试重启
        if (managed.status.state === 'running' && contribution.restartOnFailure !== false) {
          this.scheduleRestart(managed)
        }
      }
    }, timeout)
  }

  private scheduleRestart(managed: ManagedService): void {
    const { contribution, status } = managed
    const maxRestarts = contribution.maxRestarts ?? 3

    if (status.restartCount >= maxRestarts) {
      log.warn(`Service ${contribution.id} exceeded max restarts (${maxRestarts})`)
      status.state = 'error'
      status.lastError = `Exceeded max restarts: ${maxRestarts}`
      return
    }

    // 指数退避重启
    const delay = Math.min(1000 * Math.pow(2, status.restartCount), 30000)
    log.info(`Scheduling restart for ${contribution.id} in ${delay}ms`)

    managed.restartTimer = setTimeout(() => {
      status.restartCount++
      void this.startService(contribution.pluginId, contribution)
    }, delay)
  }
}

// 导出单例
export const pluginServiceManager = new PluginServiceManager()
