/**
 * CreateWorkspaceModal 插件席位（W3 域出仓）
 *
 * 宿主 Workspace 域组件已随 workspace-manager 插件出仓；App.tsx 的
 * 「无工作区时强制创建」入口保留本转发壳：从插件 entry 模块取具名导出
 * CreateWorkspaceModal 渲染。插件未就绪时渲染提示（无工作区场景不能静默）。
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { pluginRegistry } from '@/plugin-system/registry'
import { loadModuleFromFile, resolvePluginEntryPath } from '@/plugin-system/pluginModuleLoader'
import { createLogger } from '@/utils/logger'

const log = createLogger('WorkspaceCreateModalSlot')

type ModalComponent = React.ComponentType<{ onClose: () => void }> | null
let cachedComponent: ModalComponent = null
let loadPromise: Promise<ModalComponent> | null = null

async function loadModal(): Promise<ModalComponent> {
  if (cachedComponent) return cachedComponent
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const manifest = pluginRegistry.getPlugin('workspace-manager')
        const entry = manifest?.contributes?.panel?.entry
        const installPath = manifest?.installPath
        if (!manifest || !entry || !installPath) return null
        const mod = await loadModuleFromFile(resolvePluginEntryPath(installPath, entry))
        const C = (mod as { CreateWorkspaceModal?: ModalComponent }).CreateWorkspaceModal
        if (typeof C !== 'function') {
          log.warn('workspace-manager entry 未导出 CreateWorkspaceModal（插件版本过旧）')
          return null
        }
        cachedComponent = C
        return C
      } catch (err) {
        log.warn('CreateWorkspaceModal 加载失败', { err: String(err) })
        return null
      } finally {
        loadPromise = null
      }
    })()
  }
  return loadPromise
}

export function WorkspaceCreateModalSlot({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('common')
  const [Component, setComponent] = useState<ModalComponent>(cachedComponent)

  useEffect(() => {
    if (cachedComponent) {
      setComponent(cachedComponent)
      return
    }
    let alive = true
    void loadModal().then((C) => {
      if (alive) setComponent(C)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!Component) {
    return (
      <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/50">
        <div className="rounded-xl bg-background-elevated border border-border px-6 py-4 text-sm text-text-secondary">
          {t('workspaceSlot.loading', { defaultValue: '工作区组件加载中（workspace-manager 插件）…' })}
        </div>
      </div>
    )
  }
  return <Component onClose={onClose} />
}
