/**
 * WorkspaceQuickSwitch 插件席位（W3 域出仓）
 *
 * 宿主 Workspace 域组件已随 workspace-manager 插件出仓；TopMenuBar 只保留
 * 本转发壳：从插件 entry 模块取具名导出 WorkspaceQuickSwitch 渲染。
 *
 * 时序：外部插件清单由 useAppInit 异步发现（晚于本组件挂载），故经
 * usePluginStore 订阅清单到达后再加载（loadModuleFromFile：react shim 重写 +
 * blob import，moduleCache 保证单次执行）。插件未安装/禁用/未导出 → 渲染 null
 * （TopMenuBar 顶部无工作区切换入口，静默降级）。
 */

import { useSyncExternalStore } from 'react'
import { pluginRegistry } from '@/plugin-system/registry'
import { loadModuleFromFile, resolvePluginEntryPath } from '@/plugin-system/pluginModuleLoader'
import { usePluginStore } from '@/stores/pluginStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('WorkspaceQuickSwitchSlot')

type QuickSwitchComponent = React.ComponentType | null

let cached: QuickSwitchComponent = null
let loading = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function tryLoad(): void {
  if (cached || loading) return
  const manifest = pluginRegistry.getPlugin('workspace-manager')
  const entry = manifest?.contributes?.panel?.entry
  const installPath = manifest?.installPath
  if (!manifest || !entry || !installPath) return
  loading = true
  loadModuleFromFile(resolvePluginEntryPath(installPath, entry))
    .then((mod) => {
      const C = (mod as { WorkspaceQuickSwitch?: QuickSwitchComponent }).WorkspaceQuickSwitch
      if (typeof C !== 'function') {
        log.warn('workspace-manager entry 未导出 WorkspaceQuickSwitch（插件版本过旧）')
      }
      cached = typeof C === 'function' ? C : null
      notify()
    })
    .catch((err) => {
      log.warn('WorkspaceQuickSwitch 加载失败', { err: String(err) })
    })
    .finally(() => {
      loading = false
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // 清单晚到（外部插件异步发现，晚于本组件挂载）：订阅时立即尝试 + 轮询兜底
  // （pluginStore 在清单写入时未必通知；轮询至多 30 次 × 500ms，加载成功即停）
  tryLoad()
  let tries = 0
  const timer = setInterval(() => {
    tries += 1
    if (cached || tries > 30) {
      clearInterval(timer)
      return
    }
    tryLoad()
  }, 500)
  return () => {
    listeners.delete(listener)
    clearInterval(timer)
  }
}

function getSnapshot(): QuickSwitchComponent {
  return cached
}

export function WorkspaceQuickSwitchSlot() {
  const pluginStates = usePluginStore((s) => s.pluginStates)
  const enabled = !!pluginStates // 清单到达即可能加载；具体启停门在插件侧 enabledByDefault
  void enabled
  const Component = useSyncExternalStore(subscribe, getSnapshot)
  if (!Component) return null
  return <Component />
}
