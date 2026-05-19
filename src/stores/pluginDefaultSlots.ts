/**
 * 插件 defaultSlot 安置 sweep
 *
 * 把 pluginRegistry 里所有"首次见到"的视图贡献按 manifest.defaultSlot 安置到 layoutStore.
 * 仅对每个 moduleId 在生命周期内执行一次 (由 layoutStore.seenModules 持久化保证).
 *
 * 调用时机:
 * - App 启动时(在 useLayoutStoreMigration 之后,一次即可)
 * - 任何插件 install/uninstall/discover 之后(确保新插件能落到对的 slot)
 */

import { useEffect, useRef } from 'react'
import { pluginRegistry } from '@/plugin-system'
import { useLayoutStore } from './layoutStore'
import type { ModuleId, SlotId } from '@/types/layout'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginDefaultSlots')

/**
 * 执行一次 sweep,返回这次实际安置的 module 列表.
 * 注意: 同一 moduleId 只会被安置一次 (seenModules 持久化).
 */
export function sweepPluginDefaultSlots(): ModuleId[] {
  const contributions = pluginRegistry.listViewContributions('activityBar')
  const payload = contributions.map((c) => ({
    moduleId: c.moduleId,
    defaultSlot: c.defaultSlot as SlotId | undefined,
    preferredSize: c.preferredSize,
  }))
  const placed = useLayoutStore.getState().applyPluginDefaultSlots(payload)
  if (placed.length > 0) {
    log.info('Placed new plugin modules to their default slots', { placed })
  }
  return placed
}

/**
 * React Hook: 在 App 顶层调用一次, sweep 在 mount 完成后立即执行.
 *
 * 注意必须晚于 useLayoutStoreMigration: 后者会在首次启动时把旧 viewStore
 * 翻译成布局; 本 hook 再把所有 contribution 的 seenModules 标记为已见,
 * 避免下一次启动重复安置. 二者顺序固定. (App.tsx 中 hook 顺序即决定执行顺序.)
 */
export function usePluginDefaultSlotsSweep(): void {
  const didRunRef = useRef(false)
  useEffect(() => {
    if (didRunRef.current) return
    didRunRef.current = true
    sweepPluginDefaultSlots()
  }, [])
}
