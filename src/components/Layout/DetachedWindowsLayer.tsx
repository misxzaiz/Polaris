/**
 * DetachedWindowsLayer — V2 Phase 5: 所有浮动窗口的容器
 *
 * 渲染 detachedWindowStore.windows 中每一项为 DetachedWindow.
 * 关闭浮窗时, reattach 模块到原 slot (如果 layoutStore 还记得) 或默认槽位.
 *
 * 默认 reattach 槽位:
 *   - 优先 'right' (chat 已占用时跳到 'left')
 *   - 永远不进 'center' (center 是主舞台, 不接受隐式插入)
 */

import { useCallback } from 'react'
import { useDetachedWindowStore } from '@/stores/detachedWindowStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { pluginRegistry } from '@/plugin-system'
import { DetachedWindow } from './DetachedWindow'
import type { ModuleId, SlotId } from '@/types/layout'

/**
 * 选择把模块"还原"到哪个槽位.
 *  - 模块 contribution.defaultSlot 优先
 *  - 否则 right (除非 chat 占据), 否则 left
 */
function chooseReattachSlot(
  moduleId: ModuleId,
  slots: ReturnType<typeof useLayoutStore.getState>['slots']
): SlotId {
  const c = pluginRegistry
    .listViewContributions('activityBar')
    .find((view) => view.moduleId === moduleId)
  if (c?.defaultSlot && c.defaultSlot !== 'center') return c.defaultSlot
  // right 槽位首选 (除非已被 chat 独占且 chat bareRender)
  if (slots.right.modules.length === 0 || !slots.right.modules.includes('chat')) {
    return 'right'
  }
  return 'left'
}

export function DetachedWindowsLayer() {
  const windows = useDetachedWindowStore((s) => s.windows)
  const removeDetached = useDetachedWindowStore((s) => s.remove)
  const addModuleToSlot = useLayoutStore((s) => s.addModuleToSlot)

  const handleClose = useCallback(
    (moduleId: ModuleId) => {
      const slots = useLayoutStore.getState().slots
      const targetSlot = chooseReattachSlot(moduleId, slots)
      removeDetached(moduleId)
      // 仅在模块还没有出现在某个槽位时才添加 (浮窗期间用户可能已通过 Dock 重新放回去了)
      const alreadyBound = Object.values(slots).some((s) => s.modules.includes(moduleId))
      if (!alreadyBound) {
        addModuleToSlot(moduleId, targetSlot)
      }
    },
    [removeDetached, addModuleToSlot]
  )

  if (windows.length === 0) return null
  return (
    <>
      {windows.map((w) => (
        <DetachedWindow key={w.moduleId} window={w} onClose={handleClose} />
      ))}
    </>
  )
}
