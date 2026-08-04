/**
 * focusModeStore - 全局阅读聚焦模式状态管理
 *
 * 三档模式：
 *   0 = 关闭（默认）
 *   1 = 语义聚焦（L1）：鼠标悬停的消息块/段落提亮，兄弟降亮度。全程 CSS，零 JS 运行时
 *   2 = 聚光灯（L2）：在 L1 之上叠加全屏 pointer-events:none 遮罩，鼠标处挖高亮圆
 *
 * 设计原则：
 *   - L1 不走 overlayStore（只高亮聊天消息，不遮挡浏览器面板）
 *   - L2 走 overlayStore 计数器：全屏遮罩会遮挡内置浏览器，需 OverlayGuard 隐藏 WebView
 *   - 移动端强制 off：触屏无悬停语义
 *   - 持久化到 localStorage，跟随用户偏好
 *   - L1 不挂 mousemove 监听；仅 L2 激活时 FocusOverlay 才挂载 rAF 节流的 mousemove
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { isTauri } from '@/utils/platform'
import { useOverlayStore } from './overlayStore'

export type FocusLevel = 0 | 1 | 2

interface FocusModeState {
  /** 当前聚焦等级：0 关闭 / 1 语义 / 2 聚光灯 */
  level: FocusLevel
  /** 聚光灯清晰半径（px），仅 L2 生效 */
  spotClearRadius: number
  /** 聚光灯模糊强度（px），仅 L2 生效；0 = 不模糊（降档） */
  spotBlur: number
  /** 兄弟节点降亮度（0-1），仅 L1 生效 */
  dimOpacity: number
  /** 兄弟节点降亮（0-1），仅 L1 生效 */
  dimBrightness: number

  /** 设置聚焦等级（处理 overlayStore 计数与移动端门控） */
  setLevel: (level: FocusLevel) => void
  /** 在 0 → 1 → 2 → 0 之间循环（快捷键用） */
  cycleLevel: () => void
  /** 直接切换 L1 开关（0 ↔ 1） */
  toggle: () => void
  /** 切换 L2 强模式（0/1 ↔ 2） */
  toggleStrong: () => void
  setSpotClearRadius: (r: number) => void
  setSpotBlur: (b: number) => void
  setDimOpacity: (o: number) => void
  setDimBrightness: (b: number) => void
}

/** 移动端门控：触屏无悬停语义，聚焦功能不可用 */
function isFocusAvailable(): boolean {
  return isTauri()
}

/** 同步 overlayStore 计数器：仅 L2（全屏聚光灯遮罩）需要隐藏原生 WebView，
 *  L1（语义聚焦）只在 body 加类高亮聊天消息，不遮挡浏览器面板，不 increment */
function syncOverlay(prev: FocusLevel, next: FocusLevel): void {
  const wasSpot = prev === 2
  const willSpot = next === 2
  if (!wasSpot && willSpot) {
    useOverlayStore.getState().increment()
  } else if (wasSpot && !willSpot) {
    useOverlayStore.getState().decrement()
  }
}

export const useFocusModeStore = create<FocusModeState>()(
  persist(
    (set, get) => ({
      level: 0,
      spotClearRadius: 200,
      spotBlur: 3,
      dimOpacity: 0.32,
      dimBrightness: 0.5,

      setLevel: (level) => {
        if (level > 0 && !isFocusAvailable()) return // 移动端门控
        const prev = get().level
        if (prev === level) return
        syncOverlay(prev, level)
        set({ level })
      },

      cycleLevel: () => {
        const cur = get().level
        const next = ((cur + 1) % 3) as FocusLevel
        get().setLevel(next)
      },

      toggle: () => {
        const cur = get().level
        get().setLevel(cur > 0 ? 0 : 1)
      },

      toggleStrong: () => {
        const cur = get().level
        get().setLevel(cur === 2 ? 1 : 2)
      },

      setSpotClearRadius: (r) => set({ spotClearRadius: r }),
      setSpotBlur: (b) => set({ spotBlur: b }),
      setDimOpacity: (o) => set({ dimOpacity: o }),
      setDimBrightness: (b) => set({ dimBrightness: b }),
    }),
    {
      name: 'polaris-focus-mode',
      partialize: (s) => ({
        spotClearRadius: s.spotClearRadius,
        spotBlur: s.spotBlur,
        dimOpacity: s.dimOpacity,
        dimBrightness: s.dimBrightness,
        // level 不持久化：每次启动默认关闭，避免开机就遮罩
      }),
    },
  ),
)

/** 便捷读取：当前是否激活（level > 0） */
export const isFocusActive = (): boolean => useFocusModeStore.getState().level > 0
