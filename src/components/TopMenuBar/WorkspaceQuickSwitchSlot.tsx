/**
 * WorkspaceQuickSwitch 插件席位（W3 域出仓）
 *
 * 宿主 Workspace 域组件已随 workspace-manager 插件出仓；TopMenuBar 只保留
 * 本转发壳：插件启用且已注册 → 从插件 entry 模块取具名导出 WorkspaceQuickSwitch
 * 渲染；插件未就绪/禁用 → 渲染 null（TopMenuBar 顶部无工作区切换入口）。
 *
 * 模块解析：workspace-manager 的 panel.entry（dist/panel.js）默认导出管理面板，
 * 具名导出 WorkspaceQuickSwitch；registry.registerPanel 已按 panelType
 * 'workspaceManager' 注册 loader，这里经 panelRegistry.load 拿不到具名导出，
 * 故直接走 loadModuleFromFile（同一路径，moduleCache 保证单次执行）。
 */

import { useEffect, useState } from 'react'
import { pluginRegistry } from '@/plugin-system/registry'
import { loadModuleFromFile, resolvePluginEntryPath } from '@/plugin-system/pluginModuleLoader'
import { isPluginUiEnabled } from '@/stores/pluginStore'
import { usePluginStore } from '@/stores/pluginStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('WorkspaceQuickSwitchSlot')

type QuickSwitchComponent = React.ComponentType | null
let cachedComponent: QuickSwitchComponent = null
let loadPromise: Promise<QuickSwitchComponent> | null = null

async function loadQuickSwitch(): Promise<QuickSwitchComponent> {
  if (cachedComponent) return cachedComponent
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const manifest = pluginRegistry.getPlugin('workspace-manager')
        const entry = manifest?.contributes?.panel?.entry
        const installPath = manifest?.installPath
        if (!manifest || !entry || !installPath) return null
        const mod = await loadModuleFromFile(resolvePluginEntryPath(installPath, entry))
        const C = (mod as { WorkspaceQuickSwitch?: React.ComponentType }).WorkspaceQuickSwitch
        if (typeof C !== 'function') {
          log.warn('workspace-manager entry 未导出 WorkspaceQuickSwitch（插件版本过旧）')
          return null
        }
        cachedComponent = C
        return C
      } catch (err) {
        log.warn('WorkspaceQuickSwitch 加载失败', { err: String(err) })
        return null
      } finally {
        loadPromise = null
      }
    })()
  }
  return loadPromise
}

export function WorkspaceQuickSwitchSlot() {
  const pluginStates = usePluginStore((s) => s.pluginStates)
  const [Component, setComponent] = useState<QuickSwitchComponent>(cachedComponent)

  const enabled = isPluginUiEnabled(pluginStates, 'workspace-manager')

  useEffect(() => {
    if (!enabled || cachedComponent) {
      setComponent(cachedComponent)
      return
    }
    let alive = true
    void loadQuickSwitch().then((C) => {
      if (alive) setComponent(C)
    })
    return () => {
      alive = false
    }
  }, [enabled])

  if (!enabled || !Component) return null
  return <Component />
}
