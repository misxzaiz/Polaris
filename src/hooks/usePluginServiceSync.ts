/**
 * 插件服务同步 Hook
 *
 * 监听 pluginStore.pluginStates 变化，自动启停后端服务。
 * - 插件 enabled=true：启动其所有 autoStart 服务
 * - 插件 enabled=false：停止其所有服务
 *
 * 由 App 顶层 useAppInit 之后挂载一次即可。
 */

import { useEffect, useRef } from 'react'
import { usePluginStore } from '@/stores/pluginStore'
import { usePluginServiceStore } from '@/stores/pluginServiceStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { pluginRegistry } from '@/plugin-system'
import { pluginServiceManager } from '@/services/pluginServiceManager'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginServiceSync')

export function usePluginServiceSync() {
  const pluginStates = usePluginStore((s) => s.pluginStates)
  const hydratedFromBackend = usePluginStore((s) => s.hydratedFromBackend)
  // 上一次同步过的 enabled 快照（避免重复触发）
  const prevSnapshot = useRef<Record<string, boolean>>({})
  // 防止首次 hydrate 触发（首次启动由 useAppInit 的 autoStartAll 负责）
  const firstSyncDone = useRef(false)

  useEffect(() => {
    if (!hydratedFromBackend) return

    // 首次同步：把当前快照吃下，不发任何 RPC（autoStartAll 已处理）
    if (!firstSyncDone.current) {
      const initial: Record<string, boolean> = {}
      for (const plugin of pluginRegistry.listPlugins()) {
        const state = pluginStates[plugin.id]
        initial[plugin.id] = state ? state.enabled : plugin.enabledByDefault
      }
      prevSnapshot.current = initial
      firstSyncDone.current = true
      return
    }

    const workspacePath = useWorkspaceStore.getState().getCurrentWorkspace()?.path
    const plugins = pluginRegistry.listPlugins()
    const serviceStore = usePluginServiceStore.getState()

    const next: Record<string, boolean> = {}
    for (const plugin of plugins) {
      const state = pluginStates[plugin.id]
      next[plugin.id] = state ? state.enabled : plugin.enabledByDefault
    }

    void (async () => {
      for (const plugin of plugins) {
        const services = plugin.contributes.services ?? []
        if (services.length === 0) continue
        const prev = prevSnapshot.current[plugin.id]
        const curr = next[plugin.id]
        if (prev === curr) continue

        if (curr) {
          // 启用 → 启动 autoStart 服务
          for (const service of services) {
            if (service.autoStart === false) continue
            try {
              const status = await pluginServiceManager.startService(
                plugin.id,
                service,
                plugin.installPath ?? '',
                workspacePath,
              )
              serviceStore.updateServiceStatus(status)
            } catch (err) {
              log.warn('Failed to start service on plugin enable', {
                pluginId: plugin.id,
                serviceId: service.id,
                error: String(err),
              })
            }
          }
        } else {
          // 禁用 → 停止所有服务
          try {
            const stopped = await pluginServiceManager.stopServicesForPlugin(plugin.id)
            for (const status of stopped) {
              serviceStore.updateServiceStatus(status)
            }
          } catch (err) {
            log.warn('Failed to stop services on plugin disable', {
              pluginId: plugin.id,
              error: String(err),
            })
          }
        }
      }

      prevSnapshot.current = next
    })()
  }, [pluginStates, hydratedFromBackend])
}
