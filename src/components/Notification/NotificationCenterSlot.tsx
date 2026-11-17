/**
 * NotificationCenter 插件席位（W3 域出仓）
 *
 * 消息中心面板随 notification-desk 插件出仓；App.tsx 的 RightSlideOver 退场保活
 * 语义留在宿主。插件未就绪时渲染提示（overlay 已打开，不能静默空白）。
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { pluginRegistry } from '@/plugin-system/registry'
import { loadModuleFromFile, resolvePluginEntryPath } from '@/plugin-system/pluginModuleLoader'
import { createLogger } from '@/utils/logger'

const log = createLogger('NotificationCenterSlot')

type PanelComponent = React.ComponentType<{ onClose?: () => void }> | null
let cachedComponent: PanelComponent = null
let loadPromise: Promise<PanelComponent> | null = null

async function loadPanel(): Promise<PanelComponent> {
  if (cachedComponent) return cachedComponent
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const manifest = pluginRegistry.getPlugin('notification-desk')
        const entry = manifest?.contributes?.panel?.entry
        const installPath = manifest?.installPath
        if (!manifest || !entry || !installPath) return null
        const mod = await loadModuleFromFile(resolvePluginEntryPath(installPath, entry))
        const C = (mod as { NotificationCenterPanel?: PanelComponent }).NotificationCenterPanel
        if (typeof C !== 'function') {
          log.warn('notification-desk entry 未导出 NotificationCenterPanel（插件版本过旧）')
          return null
        }
        cachedComponent = C
        return C
      } catch (err) {
        log.warn('NotificationCenterPanel 加载失败', { err: String(err) })
        return null
      } finally {
        loadPromise = null
      }
    })()
  }
  return loadPromise
}

export function NotificationCenterSlot({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation('common')
  const [Component, setComponent] = useState<PanelComponent>(cachedComponent)

  useEffect(() => {
    if (cachedComponent) {
      setComponent(cachedComponent)
      return
    }
    let alive = true
    void loadPanel().then((C) => {
      if (alive) setComponent(C)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!Component) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-tertiary">
        {t('notificationCenter.slotLoading', { defaultValue: '消息中心加载中（notification-desk 插件）…' })}
      </div>
    )
  }
  return <Component onClose={onClose} />
}
