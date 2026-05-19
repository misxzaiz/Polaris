/**
 * detachedWindowStore — V2 Phase 5: 模块浮动窗口状态
 *
 * 功能:
 *   把某个模块从槽位 detach 出来, 渲染为浮动窗口 (fixed 定位).
 *   用户拖动 title bar 改位置, 拖角改尺寸, 关闭则 reattach 回某槽位.
 *
 * 设计:
 *   - 每个 DetachedWindow 持有 { moduleId, x, y, width, height, zIndex }
 *   - moduleId 唯一: 一个模块同一时刻只能 detach 一份 (避免冲突)
 *   - z-index 通过 bring-to-front 维护: 拖动或点击时升到栈顶
 *   - 持久化所有字段, 但启动时 clamp 到当前视口内 (防止旧位置在外屏)
 *
 * 与 layoutStore 的协作:
 *   - detach: 调用方负责先从 layoutStore.removeModuleFromSlot, 再调 detach
 *   - reattach: 调用方负责调 detach store.remove, 再 layoutStore.addModuleToSlot
 *   - store 之间不直接耦合, 由命令层 (useBuiltinCommands / DetachedWindow.onClose) 编排
 *
 * Tauri 多窗口:
 *   - 本期只做"同窗口浮动"(web fallback)
 *   - 后续可在 detach store 加 useTauriWindow: boolean, 由独立 store 调度
 *     Tauri 多窗口 API; 接口本期已经为此预留
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ModuleId } from '@/types/layout'

export interface DetachedWindowState {
  moduleId: ModuleId
  x: number
  y: number
  width: number
  height: number
  zIndex: number
}

interface DetachedWindowStoreState {
  windows: DetachedWindowState[]
  /** zIndex 计数器, bring-to-front 时递增. */
  nextZ: number
}

interface DetachedWindowStoreActions {
  /**
   * 把模块从槽位中"拿出来"放到浮窗. 已存在 moduleId 的 detached 会被替换.
   * 默认位置: 视口中央; 默认尺寸: 360×320.
   */
  detach: (
    moduleId: ModuleId,
    opts?: { x?: number; y?: number; width?: number; height?: number }
  ) => void
  /** 关闭某个浮窗 (调用方负责再调 layoutStore.addModuleToSlot 还原, 此处只删 state) */
  remove: (moduleId: ModuleId) => void
  /** 拖动后更新位置 */
  updatePosition: (moduleId: ModuleId, x: number, y: number) => void
  /** 拖角改尺寸 */
  updateSize: (moduleId: ModuleId, width: number, height: number) => void
  /** 点击/拖动 title bar 时升到栈顶 */
  bringToFront: (moduleId: ModuleId) => void
  /** 查询模块当前是否被 detach */
  isDetached: (moduleId: ModuleId) => boolean
}

export type DetachedWindowStore = DetachedWindowStoreState & DetachedWindowStoreActions

const DEFAULT_WIDTH = 360
const DEFAULT_HEIGHT = 320
const MIN_WIDTH = 240
const MIN_HEIGHT = 180

function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  vw: number,
  vh: number
): { x: number; y: number; width: number; height: number } {
  const w = Math.max(MIN_WIDTH, Math.min(width, vw))
  const h = Math.max(MIN_HEIGHT, Math.min(height, vh))
  // 保留 30px title bar 在屏内, 防止用户拖到完全看不见
  const maxX = vw - 30
  const maxY = vh - 30
  const minX = 30 - w
  const cx = Math.max(minX, Math.min(maxX, x))
  const cy = Math.max(0, Math.min(maxY, y))
  return { x: cx, y: cy, width: w, height: h }
}

/** 获取视口尺寸; SSR 安全 */
function getViewport(): { vw: number; vh: number } {
  if (typeof window === 'undefined') return { vw: 1280, vh: 800 }
  return { vw: window.innerWidth, vh: window.innerHeight }
}

export const useDetachedWindowStore = create<DetachedWindowStore>()(
  persist(
    (set, get) => ({
      windows: [],
      nextZ: 100,

      detach: (moduleId, opts = {}) =>
        set((state) => {
          const { vw, vh } = getViewport()
          const width = opts.width ?? DEFAULT_WIDTH
          const height = opts.height ?? DEFAULT_HEIGHT
          const x = opts.x ?? Math.round((vw - width) / 2)
          const y = opts.y ?? Math.round((vh - height) / 2)
          const clamped = clampToViewport(x, y, width, height, vw, vh)
          const zIndex = state.nextZ + 1
          const existing = state.windows.filter((w) => w.moduleId !== moduleId)
          return {
            windows: [...existing, { moduleId, ...clamped, zIndex }],
            nextZ: zIndex,
          }
        }),

      remove: (moduleId) =>
        set((state) => ({
          windows: state.windows.filter((w) => w.moduleId !== moduleId),
        })),

      updatePosition: (moduleId, x, y) =>
        set((state) => {
          const { vw, vh } = getViewport()
          return {
            windows: state.windows.map((w) => {
              if (w.moduleId !== moduleId) return w
              const c = clampToViewport(x, y, w.width, w.height, vw, vh)
              return { ...w, x: c.x, y: c.y }
            }),
          }
        }),

      updateSize: (moduleId, width, height) =>
        set((state) => {
          const { vw, vh } = getViewport()
          return {
            windows: state.windows.map((w) => {
              if (w.moduleId !== moduleId) return w
              const c = clampToViewport(w.x, w.y, width, height, vw, vh)
              return { ...w, width: c.width, height: c.height }
            }),
          }
        }),

      bringToFront: (moduleId) =>
        set((state) => {
          const target = state.windows.find((w) => w.moduleId === moduleId)
          if (!target) return state
          if (target.zIndex === state.nextZ) return state // 已在最前
          const z = state.nextZ + 1
          return {
            windows: state.windows.map((w) =>
              w.moduleId === moduleId ? { ...w, zIndex: z } : w
            ),
            nextZ: z,
          }
        }),

      isDetached: (moduleId) => get().windows.some((w) => w.moduleId === moduleId),
    }),
    {
      name: 'detached-window-store',
      version: 1,
      partialize: (state) => ({
        windows: state.windows,
        nextZ: state.nextZ,
      }),
      // 启动时 rehydrate, 把每个 window 的 x/y/width/height 重新 clamp 到当前视口
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const { vw, vh } = getViewport()
        state.windows = state.windows.map((w) => {
          const c = clampToViewport(w.x, w.y, w.width, w.height, vw, vh)
          return { ...w, ...c }
        })
      },
    }
  )
)
