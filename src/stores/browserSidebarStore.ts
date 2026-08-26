/**
 * BrowserSidebarStore - 左侧边栏浏览器面板状态管理
 *
 * 管理快捷访问、历史记录、书签、AI 信息源等数据的持久化。
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

export interface BookmarkFolder {
  id: string
  name: string
  parentId: string | null
  order: number
}

export interface BookmarkItem {
  id: string
  url: string
  title: string
  folderId: string | null
  order: number
  createdAt: number
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

export type SidebarTabName = 'quick' | 'history' | 'bookmark' | 'aiSource' | 'tools'

// ─── Store 类型 ─────────────────────────────────────

interface BrowserSidebarState {
  shortcuts: ShortcutItem[]
  history: HistoryEntry[]
  bookmarkFolders: BookmarkFolder[]
  bookmarks: BookmarkItem[]
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

  // 书签
  addBookmark: (url: string, title: string, folderId?: string) => void
  removeBookmark: (id: string) => void
  updateBookmark: (id: string, data: Partial<BookmarkItem>) => void
  addFolder: (name: string, parentId?: string) => void
  removeFolder: (id: string) => void
  renameFolder: (id: string, name: string) => void

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
      bookmarkFolders: [
        { id: nextId(), name: '开发工具', parentId: null, order: 0 },
        { id: nextId(), name: '文档', parentId: null, order: 1 },
      ],
      bookmarks: [],
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

      // ── 书签 ──
      addBookmark: (url, title, folderId) => {
        set((s) => {
          // 去重
          if (s.bookmarks.some((b) => b.url === url)) return s
          const newItem: BookmarkItem = {
            id: nextId(),
            url,
            title: title || url,
            folderId: folderId ?? null,
            order: s.bookmarks.length,
            createdAt: Date.now(),
          }
          return { bookmarks: [...s.bookmarks, newItem] }
        })
      },

      removeBookmark: (id) => {
        set((s) => ({
          bookmarks: s.bookmarks.filter((b) => b.id !== id),
        }))
      },

      updateBookmark: (id, data) => {
        set((s) => ({
          bookmarks: s.bookmarks.map((b) =>
            b.id === id ? { ...b, ...data } : b
          ),
        }))
      },

      addFolder: (name, parentId) => {
        set((s) => {
          const newFolder: BookmarkFolder = {
            id: nextId(),
            name,
            parentId: parentId ?? null,
            order: s.bookmarkFolders.length,
          }
          return { bookmarkFolders: [...s.bookmarkFolders, newFolder] }
        })
      },

      removeFolder: (id) => {
        set((s) => ({
          bookmarkFolders: s.bookmarkFolders.filter((f) => f.id !== id),
          // 将文件夹内的书签移到根目录
          bookmarks: s.bookmarks.map((b) =>
            b.folderId === id ? { ...b, folderId: null } : b
          ),
        }))
      },

      renameFolder: (id, name) => {
        set((s) => ({
          bookmarkFolders: s.bookmarkFolders.map((f) =>
            f.id === id ? { ...f, name } : f
          ),
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
        bookmarkFolders: state.bookmarkFolders,
        bookmarks: state.bookmarks,
        aiSources: state.aiSources,
        injectedHistory: state.injectedHistory,
      }),
    }
  )
)