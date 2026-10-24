/**
 * 插件生命周期事件订阅（P0）
 *
 * 消费后端 `plugin.lifecycle` 事件（plugin_state_save diff / cap.pluginDiscovery 写动作 emit），
 * 让「插件管理」与「生效」在其它非 PluginTab 消费方也能感知：
 * - 感知逻辑统一在后端（diff → 广播），前端只做展示/回填（见 plans/plugin-manage-hook-inject-v1.md §9）。
 * - 本 subscriber 是「轻展示层」：收到事件 → 刷新本地插件状态 + 触发安装清单重发现（若 install/uninstall/update）。
 *
 * 边界：
 * - PluginTab 已自带 refreshInstalledPlugins（操作后自刷新），本 subscriber 只为「非 PluginTab 场景」
 *   提供统一刷新钩子；双刷新无副作用（replaceInstalled 幂等）。
 * - 不做磁盘持久化、不做服务启停（那是后端 PluginServiceManager / usePluginServiceSync 的职责）。
 */

import { listen } from '@/services/transport'
import { discoverInstalledPlugins } from '@/services/pluginDiscoveryService'
import { pluginRegistry } from '@/plugin-system'
import type { PluginServiceStatus } from '@/plugin-system/types'
import { usePluginStore } from '@/stores/pluginStore'
import { usePluginServiceStore } from '@/stores/pluginServiceStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { createLogger } from '@/utils/logger'

type UnlistenFn = () => void

const log = createLogger('PluginLifecycleSubscriber')

/** 后端 plugin.lifecycle 事件载荷（camelCase，对齐 Rust PluginStateChangeOverview） */
export interface PluginLifecycleEvent {
  pluginId?: string
  event: 'installed' | 'uninstalled' | 'updated' | 'state_changed'
  installPath?: string
  detail?: {
    changed?: string[]
    initial?: boolean
    installPath?: string
  }
}

/** 需要触发安装清单重发现的事件（registry 层变化） */
const REDISCOVER_EVENTS = new Set(['installed', 'uninstalled', 'updated'])

/**
 * 订阅 plugin.lifecycle → 刷新插件状态 / 触发安装清单重发现。
 * 挂到 App 顶层（useAppEvents），面板未打开时也能保持感知。
 * @returns 清理函数（取消监听）
 */
export function initPluginLifecycleSubscriber(): () => void {
  let unlisten: UnlistenFn | null = null
  let disposed = false

  const onLifecycle = (payload: PluginLifecycleEvent) => {
    if (disposed) return
    const { event, pluginId } = payload
    log.debug('plugin.lifecycle event', { event, pluginId })

    // 1. 刷新本地插件状态（开关真相）
    void usePluginStore.getState().loadPluginStates().catch((error) => {
      log.warn('plugin.lifecycle: 刷新插件状态失败', {
        error: error instanceof Error ? error.message : String(error),
      })
    })

    // 2. install/uninstall/update → 重发现安装清单并同步注册表
    if (REDISCOVER_EVENTS.has(event)) {
      const workspacePath = useWorkspaceStore.getState().getCurrentWorkspace()?.path
      void discoverInstalledPlugins(workspacePath)
        .then((result) => {
          if (!result || !Array.isArray(result.plugins)) return
          void pluginRegistry.replaceInstalled(result.plugins)
          log.info('plugin.lifecycle: 已重发现并同步插件清单', {
            event,
            count: result.plugins.length,
          })
        })
        .catch((error) => {
          log.warn('plugin.lifecycle: 插件清单重发现失败', {
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }
  }

  listen<PluginLifecycleEvent>('plugin.lifecycle', onLifecycle).then((fn) => {
    if (disposed) {
      fn()
      return
    }
    unlisten = fn
  })

  // 后端 PluginServiceManager 状态回推（P1-3，2026-10-24 审计）：
  // 自动重启/Error/健康翻转等后端状态变化此前只改内存，UI 长期陈旧；
  // 现经 plugin.service.status 事件实时回填 pluginServiceStore。
  const onServiceStatus = (payload: PluginServiceStatus) => {
    if (disposed) return
    if (!payload || !payload.pluginId || !payload.serviceId) return
    usePluginServiceStore.getState().updateServiceStatus(payload)
  }

  let unlistenService: UnlistenFn | null = null
  listen<PluginServiceStatus>('plugin.service.status', onServiceStatus).then((fn) => {
    if (disposed) {
      fn()
      return
    }
    unlistenService = fn
  })

  return () => {
    disposed = true
    unlisten?.()
    unlisten = null
    unlistenService?.()
    unlistenService = null
  }
}
