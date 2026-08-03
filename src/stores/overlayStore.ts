/**
 * overlayStore - 浏览器 WebView 覆盖层状态管理
 *
 * 功能：
 *   跟踪当前是否有覆盖层（模态框/面板/弹窗）遮挡内置浏览器，
 *   BrowserPanel 订阅 count > 0 时立即隐藏原生 WebView，
 *   避免 WebView2 始终位于 HTML 内容之上的问题。
 *
 * 使用方式：
 *   - 通用计数器：useOverlayStore.getState().increment() / decrement()
 *   - App.tsx 级面板：setSettingsOpen(true/false) 等自动管理 count
 *   - 或使用 <OverlayGuard> 组件自动管理（Phase 2）
 *
 * 设计原则：
 *   - 使用计数器而非单一布尔值，支持嵌套覆盖层
 *     （如 CreateSessionModal 内打开 CreateWorkspaceModal）
 *   - 非持久化（persist: false），覆盖层状态随应用生命周期
 *   - 引用稳定，setter 可通过 getState() 直接调用，不依赖闭包
 */

import { create } from 'zustand'

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
}

export const useOverlayStore = create<OverlayState>((set, get) => ({
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
}))