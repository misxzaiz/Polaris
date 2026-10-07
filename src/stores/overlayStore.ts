/**
 * overlayStore - 浮层状态管理
 *
 * 两层职责：
 *   1. 计数器（count）：跟踪当前覆盖层数量，BrowserPanel 订阅 count > 0 时
 *      隐藏原生 WebView（避免 WebView2 始终置顶）。
 *   2. popover 独占锁（activePopoverId）：同一 z-popover 层的浮层互斥，
 *      打开新 popover 前自动关闭旧的，避免"DOM 序反压"导致下拉互相盖死。
 *
 * 设计原则：
 *   - 计数器支持嵌套覆盖层（如 CreateSessionModal 内打开 CreateWorkspaceModal）
 *   - popover 锁是"建议性"的：组件打开时 claimPopover(id)，旧 id 会被通知关闭
 *   - 非持久化（persist: false），覆盖层状态随应用生命周期
 *   - 引用稳定，setter 可通过 getState() 直接调用，不依赖闭包
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface OverlayState {
  /** 当前活跃的覆盖层数量。0 = 无覆盖，> 0 = 有覆盖 */
  count: number
  /** 覆盖层计数器 +1 */
  increment: () => void
  /** 覆盖层计数器 -1（最低 0） */
  decrement: () => void

  // ── App.tsx 级面板状态（自动同步 count） ──

  /** 设置面板是否打开 */
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void

  /** 新建会话弹窗是否打开 */
  createSessionOpen: boolean
  setCreateSessionOpen: (open: boolean) => void

  /** 文件搜索弹窗是否打开 */
  fileSearchOpen: boolean
  setFileSearchOpen: (open: boolean) => void
  toggleFileSearch: () => void

  /** 文件搜索是否钉住（浮窗模式）。跨会话持久化 */
  fileSearchPinned: boolean
  setFileSearchPinned: (v: boolean) => void

  // ── popover 独占锁 ──
  // 同一 z-popover 层的浮层互斥：打开新 popover 时旧 id 失效。
  // claim 返回上一次的 id（调用方据此关闭自己）；release 仅在自己是当前持有者时清空。

  /** 当前持有 popover 锁的 id（null = 无 popover 打开） */
  activePopoverId: string | null
  /** 认领 popover 锁。返回上一个持有者 id（调用方可通知它关闭）。 */
  claimPopover: (id: string) => string | null
  /** 释放 popover 锁（仅当自己是当前持有者时清空，避免被后来的 popover 误清）。 */
  releasePopover: (id: string) => void
}

export const useOverlayStore = create<OverlayState>()(
  persist(
    (set, get) => ({
      count: 0,

      increment: () => set((state) => ({ count: state.count + 1 })),

      decrement: () => set((state) => ({ count: Math.max(0, state.count - 1) })),

      // ── App.tsx 级面板状态 ──

      settingsOpen: false,
      setSettingsOpen: (open) => {
        const prev = get().settingsOpen
        if (open && !prev) get().increment()
        else if (!open && prev) get().decrement()
        set({ settingsOpen: open })
      },

      createSessionOpen: false,
      setCreateSessionOpen: (open) => {
        const prev = get().createSessionOpen
        if (open && !prev) get().increment()
        else if (!open && prev) get().decrement()
        set({ createSessionOpen: open })
      },

      fileSearchOpen: false,
      setFileSearchOpen: (open) => {
        const prev = get().fileSearchOpen
        if (open && !prev) get().increment()
        else if (!open && prev) get().decrement()
        set({ fileSearchOpen: open })
      },
      toggleFileSearch: () => {
        const next = !get().fileSearchOpen
        get().setFileSearchOpen(next)
      },

      fileSearchPinned: false,
      setFileSearchPinned: (v) => set({ fileSearchPinned: v }),

      // ── popover 独占锁 ──

      activePopoverId: null,
      claimPopover: (id) => {
        const prev = get().activePopoverId
        set({ activePopoverId: id })
        return prev
      },
      releasePopover: (id) => {
        if (get().activePopoverId === id) {
          set({ activePopoverId: null })
        }
      },
    }),
    {
      name: 'polaris-overlay',
      // 仅持久化钉住偏好；会话级状态（count/open/popover）不存
      partialize: (s) => ({ fileSearchPinned: s.fileSearchPinned }),
    },
  ),
)