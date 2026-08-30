/**
 * Tab Store
 *
 * 管理 Tab 状态,用于中间编辑区的 Tab 切换
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { GitDiffEntry } from '@/types/git'
import { useFileEditorStore } from './fileEditorStore'
import { getFileNameFromPath } from '@/utils/path'
import { browserClose, makeBrowserWebviewLabel } from '@/services/tauri/browserService'

/**
 * Tab 类型
 *
 * 内置类型：editor / diff / preview / git / browser
 * 插件可注册自定义 Tab 类型（如 "git-branch"），CenterStage 通过
 * pluginTabRendererRegistry 渲染未知类型（P0-3）。
 */
export type TabType = 'editor' | 'diff' | 'preview' | 'git' | 'browser' | (string & {})

/** Tab 数据结构 */
export interface Tab {
  id: string
  type: TabType
  title: string
  closable: boolean
  // Editor Tab 数据
  filePath?: string
  // Diff Tab 数据
  diffData?: GitDiffEntry
  // 其他元数据
  metadata?: Record<string, any>
  /** 文件是否有未保存的更改 */
  isDirty?: boolean
  /** 标签是否固定（pin tab），固定后不可关闭且在左侧显示 */
  pinned?: boolean
}

export interface OpenGitTabOptions {
  initialGitTab?: string
}

export interface OpenDiffTabOptions {
  /** Stable identity for reuse. Defaults to file path for working-tree diffs. */
  identity?: string
  /** Context shown in the tab title, such as a short commit SHA. */
  titleContext?: string
  /** Extra metadata to preserve on the diff tab. */
  metadata?: Record<string, any>
}

export interface OpenBrowserTabOptions {
  reuseExisting?: boolean
  activate?: boolean
  metadata?: Record<string, any>
}

interface TabState {
  tabs: Tab[]
  activeTabId: string | null
}

interface TabActions {
  // Tab 操作
  openEditorTab: (filePath: string, title?: string) => string
  openPreviewTab: (filePath: string, title?: string, metadata?: Record<string, any>) => string
  openDiffTab: (diff: GitDiffEntry, options?: OpenDiffTabOptions) => string
  openGitTab: (options?: OpenGitTabOptions) => string
  openBrowserTab: (url?: string, title?: string, options?: OpenBrowserTabOptions) => string
  closeTab: (tabId: string) => void
  switchTab: (tabId: string) => void
  closeAllTabs: () => void
  closeOtherTabs: (tabId: string) => void
  closeRightTabs: (tabId: string) => void
  closeSavedTabs: () => void
  /** 拖拽排序：把 fromId 标签移动到 toId 标签所在位置 */
  moveTab: (fromId: string, toId: string) => void
  /** 切换标签固定状态 */
  togglePinTab: (tabId: string) => void

  // Dirty 状态管理
  setTabDirty: (tabId: string, isDirty: boolean) => void
  updateBrowserTab: (tabId: string, updates: { url?: string; title?: string }) => void
  markBrowserNavigationHandled: (tabId: string, requestId: number) => void
  getDirtyTabs: () => Tab[]
  hasDirtyTabs: () => boolean

  // 获取操作
  getActiveTab: () => Tab | null
  getTabById: (id: string) => Tab | undefined
}

export type TabStore = TabState & TabActions

function closeBrowserResources(tabs: Tab[]) {
  tabs
    .filter((tab) => tab.type === 'browser')
    .forEach((tab) => {
      browserClose(makeBrowserWebviewLabel(tab.id)).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn(`[tabStore] browserClose failed for tab ${tab.id}:`, String(e))
      })
    })
}

let browserNavigationRequestSequence = 0

function nextBrowserNavigationRequestId(): number {
  browserNavigationRequestSequence += 1
  return browserNavigationRequestSequence
}

export const useTabStore = create<TabStore>()(
  persist(
    (set, get) => ({
      // 初始状态
      tabs: [],
      activeTabId: null,

      // 打开 Editor Tab
      openEditorTab: (filePath: string, title?: string) => {
        // 检查是否已存在相同文件的 Editor Tab，命中则激活已有 Tab
        const existingTab = get().tabs.find(
          (tab) => tab.type === 'editor' && tab.filePath === filePath
        )

        if (existingTab) {
          set({ activeTabId: existingTab.id })
          return existingTab.id
        }

        const tabId = `editor-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        const newTab: Tab = {
          id: tabId,
          type: 'editor',
          title: title || filePath.split('/').pop() || filePath,
          closable: true,
          filePath,
        }

        set((state) => ({
          tabs: [...state.tabs, newTab],
          activeTabId: tabId,
        }))

        return tabId
      },

      // 打开 Diff Tab
      openDiffTab: (diff: GitDiffEntry, options?: OpenDiffTabOptions) => {
        const diffIdentity = options?.identity ?? diff.file_path
        const titleContext = options?.titleContext
        const metadata = {
          ...options?.metadata,
          diffIdentity,
          diffTitleContext: titleContext,
        }

        // 检查是否已存在相同上下文的 Diff Tab
        const existingTab = get().tabs.find(
          (tab) => tab.type === 'diff' && (tab.metadata?.diffIdentity ?? tab.diffData?.file_path) === diffIdentity
        )

        if (existingTab) {
          // 如果已存在,更新 diffData 并切换到该 Tab
          set((state) => ({
            tabs: state.tabs.map((tab) =>
              tab.id === existingTab.id
                ? { ...tab, diffData: diff, metadata: { ...tab.metadata, ...metadata } }
                : tab
            ),
            activeTabId: existingTab.id,
          }))
          return existingTab.id
        }

        // 否则创建新 Tab
        const tabId = `diff-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        const fileName = getFileNameFromPath(diff.file_path)
        const newTab: Tab = {
          id: tabId,
          type: 'diff',
          title: titleContext ? `${fileName} @ ${titleContext} (Diff)` : `${fileName} (Diff)`,
          closable: true,
          diffData: diff,
          metadata,
        }

        set((state) => ({
          tabs: [...state.tabs, newTab],
          activeTabId: tabId,
        }))

        return tabId
      },

      // 打开 Git 工作台 Tab
      openGitTab: (options) => {
        const existingTab = get().tabs.find((tab) => tab.type === 'git')
        const metadata = options
          ? { ...options, gitFocusToken: Date.now() }
          : { gitFocusToken: Date.now() }

        if (existingTab) {
          set((state) => ({
            tabs: state.tabs.map((tab) =>
              tab.id === existingTab.id
                ? { ...tab, metadata: { ...tab.metadata, ...metadata } }
                : tab
            ),
            activeTabId: existingTab.id,
          }))
          return existingTab.id
        }

        const tabId = `git-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        const newTab: Tab = {
          id: tabId,
          type: 'git',
          title: 'Git',
          closable: true,
          metadata,
        }

        set((state) => ({
          tabs: [...state.tabs, newTab],
          activeTabId: tabId,
        }))

        return tabId
      },

      // 打开内置浏览器 Tab
      openBrowserTab: (url = 'https://www.bing.com', title = 'Browser', options = {}) => {
        const reuseExisting = options.reuseExisting ?? true
        const activate = options.activate ?? true
        const existingTab = reuseExisting
          ? get().tabs.find((tab) => tab.type === 'browser')
          : undefined
        const requestId = nextBrowserNavigationRequestId()

        if (existingTab) {
          set((state) => ({
            tabs: state.tabs.map((tab) =>
              tab.id === existingTab.id
                ? {
                    ...tab,
                    title,
                    metadata: {
                      ...tab.metadata,
                      ...options.metadata,
                      requestedUrl: url,
                      navigationRequestId: requestId,
                      navigationRequestPending: true,
                    },
                  }
                : tab
            ),
            activeTabId: activate || !state.activeTabId ? existingTab.id : state.activeTabId,
          }))
          return existingTab.id
        }

        const tabId = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        const newTab: Tab = {
          id: tabId,
          type: 'browser',
          title,
          closable: true,
          metadata: {
            initialUrl: url,
            currentUrl: url,
            requestedUrl: url,
            navigationRequestId: requestId,
            navigationRequestPending: true,
            ...options.metadata,
          },
        }

        set((state) => ({
          tabs: [...state.tabs, newTab],
          activeTabId: activate || !state.activeTabId ? tabId : state.activeTabId,
        }))

        return tabId
      },

      // 打开 Preview Tab
      openPreviewTab: (filePath: string, title?: string, metadata?: Record<string, any>) => {
        const existingTab = get().tabs.find(
          (tab) => tab.type === 'preview' && tab.filePath === filePath
        )

        if (existingTab) {
          set({ activeTabId: existingTab.id })
          return existingTab.id
        }

        const tabId = `preview-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        const newTab: Tab = {
          id: tabId,
          type: 'preview',
          title: title || filePath.split('/').pop() || filePath,
          closable: true,
          filePath,
          metadata,
        }

        set((state) => ({
          tabs: [...state.tabs, newTab],
          activeTabId: tabId,
        }))

        return tabId
      },

      // 关闭 Tab
      closeTab: (tabId: string) => {
        set((state) => {
          const closedTab = state.tabs.find((tab) => tab.id === tabId)
          // 固定标签不可关闭
          if (closedTab?.pinned) return state
          const newTabs = state.tabs.filter((tab) => tab.id !== tabId)

          // 如果关闭的是当前激活的 Tab,需要切换到另一个 Tab
          let newActiveTabId = state.activeTabId
          if (state.activeTabId === tabId) {
            if (newTabs.length > 0) {
              // 尝试切换到相邻的 Tab
              const closedIndex = state.tabs.findIndex((tab) => tab.id === tabId)
              newActiveTabId =
                newTabs[closedIndex >= newTabs.length ? newTabs.length - 1 : closedIndex].id
            } else {
              newActiveTabId = null
            }
          }

          // 清理已关闭 Tab 的编辑器缓冲区
          if (closedTab?.filePath) {
            useFileEditorStore.getState().removeBuffer(closedTab.filePath)
          }
          if (closedTab?.type === 'browser') {
            closeBrowserResources([closedTab])
          }

          return {
            tabs: newTabs,
            activeTabId: newActiveTabId,
          }
        })
      },

      // 切换 Tab
      switchTab: (tabId: string) => {
        set({ activeTabId: tabId })
      },

      // 关闭所有 Tab（保留固定标签）
      closeAllTabs: () => {
        const pinned = get().tabs.filter((t) => t.pinned)
        closeBrowserResources(get().tabs.filter((t) => !t.pinned))
        set({
          tabs: pinned,
          activeTabId: pinned.length > 0 ? pinned[0].id : null,
        })
      },

      // 关闭其他 Tab（保留固定标签）
      closeOtherTabs: (tabId: string) => {
        const pinned = get().tabs.filter((t) => t.pinned && t.id !== tabId)
        closeBrowserResources(get().tabs.filter((t) => t.id !== tabId && !t.pinned))
        set((state) => ({
          tabs: [...pinned, ...state.tabs.filter((tab) => tab.id === tabId)],
          activeTabId: tabId,
        }))
      },

      // 关闭右侧 Tab（保留固定标签）
      closeRightTabs: (tabId: string) => {
        set((state) => {
          const tabIndex = state.tabs.findIndex((tab) => tab.id === tabId)
          if (tabIndex === -1) return state

          const kept = state.tabs.slice(0, tabIndex + 1)
          const removed = state.tabs.slice(tabIndex + 1).filter((t) => !t.pinned)

          // 清理被关闭 Tab 的缓冲区
          removed.forEach((tab) => {
            if (tab.filePath) {
              useFileEditorStore.getState().removeBuffer(tab.filePath)
            }
          })
          closeBrowserResources(removed)

          // 如果当前激活 Tab 被关闭了，切换到最后一个保留的 Tab
          const isActiveRemoved = !kept.some((t) => t.id === state.activeTabId)
          const newActiveTabId = isActiveRemoved
            ? kept[kept.length - 1]?.id || null
            : state.activeTabId

          return { tabs: [...kept, ...state.tabs.slice(tabIndex + 1).filter((t) => t.pinned)], activeTabId: newActiveTabId }
        })
      },

      // 关闭已保存的 Tab（保留固定标签）
      closeSavedTabs: () => {
        set((state) => {
          const kept = state.tabs.filter((tab) => tab.isDirty || tab.pinned)
          const removed = state.tabs.filter((tab) => !tab.isDirty && !tab.pinned)

          // 清理被关闭 Tab 的缓冲区
          removed.forEach((tab) => {
            if (tab.filePath) {
              useFileEditorStore.getState().removeBuffer(tab.filePath)
            }
          })
          closeBrowserResources(removed)

          // 如果当前激活 Tab 被关闭了，切换到最后一个保留的 Tab
          const isActiveRemoved = !kept.some((t) => t.id === state.activeTabId)
          const newActiveTabId = isActiveRemoved
            ? kept[kept.length - 1]?.id || null
            : state.activeTabId

          return { tabs: kept, activeTabId: newActiveTabId }
        })
      },

      // 拖拽排序：把 fromId 标签移动到 toId 标签所在位置
      moveTab: (fromId: string, toId: string) => {
        if (fromId === toId) return
        set((state) => {
          const fromIndex = state.tabs.findIndex((tab) => tab.id === fromId)
          const toIndex = state.tabs.findIndex((tab) => tab.id === toId)
          if (fromIndex === -1 || toIndex === -1) return state

          const tabs = [...state.tabs]
          const [moved] = tabs.splice(fromIndex, 1)
          tabs.splice(toIndex, 0, moved)
          return { ...state, tabs }
        })
      },

      // 切换标签固定状态（固定区置顶，取消固定回到末尾）
      togglePinTab: (tabId: string) => {
        set((state) => {
          const idx = state.tabs.findIndex((tab) => tab.id === tabId)
          if (idx === -1) return state
          const nextPinned = !state.tabs[idx].pinned
          const mapped = state.tabs.map((t) =>
            t.id === tabId ? { ...t, pinned: nextPinned } : t
          )
          return {
            ...state,
            tabs: [...mapped.filter((t) => t.pinned), ...mapped.filter((t) => !t.pinned)],
          }
        })
      },

      // 获取当前激活的 Tab
      getActiveTab: () => {
        const state = get()
        return state.tabs.find((tab) => tab.id === state.activeTabId) || null
      },

      // 根据 ID 获取 Tab
      getTabById: (id: string) => {
        return get().tabs.find((tab) => tab.id === id)
      },

      // 设置 Tab 的 dirty 状态
      setTabDirty: (tabId: string, isDirty: boolean) => {
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, isDirty } : tab
          ),
        }))
      },

      updateBrowserTab: (
        tabId: string,
        updates: { url?: string; title?: string; metadata?: Record<string, any> }
      ) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== tabId || tab.type !== 'browser') {
              return tab
            }

            const nextTitle = updates.title?.trim()
            return {
              ...tab,
              title: nextTitle || tab.title,
              metadata: {
                ...tab.metadata,
                ...(updates.url ? { currentUrl: updates.url } : {}),
                ...(nextTitle ? { pageTitle: nextTitle } : {}),
                ...(updates.metadata ?? {}),
              },
            }
          }),
        }))
      },
      markBrowserNavigationHandled: (tabId: string, requestId: number) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (
              tab.id !== tabId ||
              tab.type !== 'browser' ||
              tab.metadata?.navigationRequestId !== requestId
            ) {
              return tab
            }
            return {
              ...tab,
              metadata: {
                ...tab.metadata,
                navigationRequestPending: false,
                navigationRequestHandledId: requestId,
              },
            }
          }),
        }))
      },

      // 获取所有 dirty 的 Tab
      getDirtyTabs: () => {
        return get().tabs.filter((tab) => tab.isDirty)
      },

      // 检查是否有 dirty 的 Tab
      hasDirtyTabs: () => {
        return get().tabs.some((tab) => tab.isDirty)
      },
    }),
    {
      name: 'tab-store',
      // 不持久化 tabs，每次启动都是空状态。
      // Browser WebView 是进程内 native 资源，不能通过前端 metadata 安全恢复。
      partialize: () => ({ tabs: [], activeTabId: null }),
    }
  )
)
