/**
 * BrowserSidebarStore - 左侧边栏浏览器面板状态管理
 *
 * 管理快捷访问、历史记录、AI 信息源等数据的持久化。
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// ─── 类型定义 ───────────────────────────────────────

export interface ShortcutItem {
  id: string
  url: string
  label: string
  pinned: boolean
  order: number
}

export interface HistoryEntry {
  id: string
  url: string
  title: string
  timestamp: number
}

export interface AiSource {
  id: string
  url: string
  title: string
  autoReference: boolean
  workspaceId: string
  createdAt: number
}

export interface InjectedEntry {
  id: string
  url: string
  title: string
  method: 'full' | 'screenshot'
  note?: string
  timestamp: number
}

export type SidebarTabName = 'quick' | 'history' | 'aiSource'

// ─── Store 类型 ─────────────────────────────────────

interface BrowserSidebarState {
  shortcuts: ShortcutItem[]
  history: HistoryEntry[]
  aiSources: AiSource[]
  injectedHistory: InjectedEntry[]
  activeTabName: SidebarTabName
}

interface BrowserSidebarActions {
  // 快捷访问
  addShortcut: (url: string, label?: string) => void
  removeShortcut: (id: string) => void
  updateShortcut: (id: string, data: Partial<ShortcutItem>) => void
  reorderShortcuts: (ids: string[]) => void

  // 历史
  addHistory: (url: string, title: string) => void
  clearHistory: () => void
  removeHistoryEntry: (id: string) => void

  // AI 信息源
  addAiSource: (url: string, title: string, autoReference?: boolean) => void
  removeAiSource: (id: string) => void
  toggleAutoReference: (id: string) => void
  addInjectedEntry: (entry: Omit<InjectedEntry, 'id' | 'timestamp'>) => void

  // UI 状态
  setActiveTabName: (name: SidebarTabName) => void
}

export type BrowserSidebarStore = BrowserSidebarState & BrowserSidebarActions

// ─── 工具函数 ───────────────────────────────────────

let idCounter = 0
function nextId(): string {
  idCounter += 1
  return `bs-${Date.now()}-${idCounter}-${Math.random().toString(36).slice(2, 6)}`
}

const DEFAULT_SHORTCUTS: ShortcutItem[] = [
  { id: nextId(), url: 'https://www.bing.com', label: 'Bing', pinned: true, order: 0 },
  { id: nextId(), url: 'https://developer.mozilla.org', label: 'MDN', pinned: true, order: 1 },
  { id: nextId(), url: 'localhost:5173', label: 'localhost:5173', pinned: true, order: 2 },
  { id: nextId(), url: 'localhost:3000', label: 'localhost:3000', pinned: true, order: 3 },
  { id: nextId(), url: 'https://tauri.app', label: 'Tauri', pinned: true, order: 4 },
]

// ─── Store 实现 ─────────────────────────────────────

export const useBrowserSidebarStore = create<BrowserSidebarStore>()(
  persist(
    (set, get) => ({
      // ── 初始状态 ──
      shortcuts: DEFAULT_SHORTCUTS,
      history: [],
      aiSources: [],
      injectedHistory: [],
      activeTabName: 'quick',

      // ── 快捷访问 ──
      addShortcut: (url, label) => {
        const { shortcuts } = get()
        const shortLabel = label || (() => {
          try { return new URL(url).hostname } catch { return url }
        })()
        const newItem: ShortcutItem = {
          id: nextId(),
          url,
          label: shortLabel,
          pinned: false,
          order: shortcuts.length,
        }
        set({ shortcuts: [...shortcuts, newItem] })
      },

      removeShortcut: (id) => {
        set((s) => ({
          shortcuts: s.shortcuts.filter((item) => item.id !== id),
        }))
      },

      updateShortcut: (id, data) => {
        set((s) => ({
          shortcuts: s.shortcuts.map((item) =>
            item.id === id ? { ...item, ...data } : item
          ),
        }))
      },

      reorderShortcuts: (ids) => {
        set((s) => {
          const map = new Map(s.shortcuts.map((item) => [item.id, item]))
          return {
            shortcuts: ids
              .map((id, _idx) => map.get(id))
              .filter((item): item is ShortcutItem => !!item)
              .map((item, idx) => ({ ...item, order: idx })),
          }
        })
      },

      // ── 历史记录 ──
      addHistory: (url, title) => {
        set((s) => {
          // 去重：如果已存在相同 URL，更新 title 和 timestamp
          const filtered = s.history.filter((h) => h.url !== url)
          const entry: HistoryEntry = {
            id: nextId(),
            url,
            title: title || url,
            timestamp: Date.now(),
          }
          return { history: [entry, ...filtered].slice(0, 200) }
        })
      },

      clearHistory: () => set({ history: [] }),

      removeHistoryEntry: (id) => {
        set((s) => ({
          history: s.history.filter((h) => h.id !== id),
        }))
      },

      // ── AI 信息源 ──
      addAiSource: (url, title, autoReference = false) => {
        set((s) => {
          if (s.aiSources.some((a) => a.url === url)) return s
          const newSource: AiSource = {
            id: nextId(),
            url,
            title: title || url,
            autoReference,
            workspaceId: '',
            createdAt: Date.now(),
          }
          return { aiSources: [...s.aiSources, newSource] }
        })
      },

      removeAiSource: (id) => {
        set((s) => ({
          aiSources: s.aiSources.filter((a) => a.id !== id),
        }))
      },

      toggleAutoReference: (id) => {
        set((s) => ({
          aiSources: s.aiSources.map((a) =>
            a.id === id ? { ...a, autoReference: !a.autoReference } : a
          ),
        }))
      },

      addInjectedEntry: (entry) => {
        set((s) => {
          const newEntry: InjectedEntry = {
            id: nextId(),
            ...entry,
            timestamp: Date.now(),
          }
          return { injectedHistory: [newEntry, ...s.injectedHistory].slice(0, 50) }
        })
      },

      // ── UI 状态 ──
      setActiveTabName: (name) => set({ activeTabName: name }),
    }),
    {
      name: 'browser-sidebar-store',
      partialize: (state) => ({
        shortcuts: state.shortcuts,
        history: state.history,
        aiSources: state.aiSources,
        injectedHistory: state.injectedHistory,
      }),
    }
  )
)