/**
 * useAppearanceSync — 将 layoutStore.appearance 同步到 documentElement
 *
 * 写入位置:
 *  - 数值字段 → style.setProperty('--app-padding', ...)
 *  - density / motion / dockMode → dataset.density / dataset.motion / dataset.dockMode
 *
 * 设计:
 *  - 在 App 顶层调用一次, 监听 store 变更自动同步
 *  - 卸载时不清除 (App 永不卸载, 清除反而会让暗色窗口闪烁)
 *  - 与 layoutStore 解耦的下游消费者: 任何 CSS 用 var(--app-padding) 即可,
 *    无需手动读取 store
 *
 * 不变量:
 *  - 即便 store 还没 hydrate 完成, DEFAULT_APPEARANCE 也保证渲染合法的初始值
 */

import { useEffect } from 'react'
import { useLayoutStore } from '@/stores/layoutStore'

export function useAppearanceSync(): void {
  const appearance = useLayoutStore((s) => s.appearance)

  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement

    // 数值字段 → CSS 变量
    root.style.setProperty('--app-padding', `${appearance.appPadding}px`)
    root.style.setProperty('--slot-gap', `${appearance.slotGap}px`)
    root.style.setProperty('--slot-radius', `${appearance.slotRadius}px`)

    // 枚举字段 → data-* 属性 (CSS 选择器消费)
    root.dataset.density = appearance.density
    root.dataset.motion = appearance.transitionLevel
    root.dataset.dockMode = appearance.dockMode
  }, [
    appearance.appPadding,
    appearance.slotGap,
    appearance.slotRadius,
    appearance.density,
    appearance.transitionLevel,
    appearance.dockMode,
  ])
}
