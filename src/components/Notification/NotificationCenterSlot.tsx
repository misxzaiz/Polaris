/**
 * NotificationCenter 插件席位（W3 域出仓）
 *
 * 消息中心面板随 notification-desk 插件出仓；App.tsx 的 RightSlideOver 退场保活
 * 语义留在宿主。React.lazy 承担异步加载生命周期（避免手写 effect 竞态）；
 * 插件未安装/加载失败时由上层 ErrorBoundary 兜底。
 */

import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { pluginRegistry } from '@/plugin-system/registry'
import { loadModuleFromFile, resolvePluginEntryPath } from '@/plugin-system/pluginModuleLoader'

async function loadPanel(): Promise<{ default: React.ComponentType<{ onClose?: () => void }> }> {
  const manifest = pluginRegistry.getPlugin('notification-desk')
  const entry = manifest?.contributes?.panel?.entry
  const installPath = manifest?.installPath
  if (!manifest || !entry || !installPath) {
    throw new Error('notification-desk 插件未安装')
  }
  const mod = await loadModuleFromFile(resolvePluginEntryPath(installPath, entry))
  const C = (mod as { NotificationCenterPanel?: React.ComponentType<{ onClose?: () => void }> })
    .NotificationCenterPanel
  if (typeof C !== 'function') {
    throw new Error('notification-desk entry 未导出 NotificationCenterPanel（插件版本过旧）')
  }
  return { default: C }
}

const LazyPanel = lazy(loadPanel)

export function NotificationCenterSlot({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation('common')
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-xs text-text-tertiary">
          {t('notificationCenter.slotLoading', { defaultValue: '消息中心加载中（notification-desk 插件）…' })}
        </div>
      }
    >
      <LazyPanel {...{ onClose }} />
    </Suspense>
  )
}
