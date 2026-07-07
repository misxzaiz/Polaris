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

/** Tab 类型 */
export type TabType = 'editor' | 'diff' | 'preview' | 'git' | 'browser'

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
      browserClose(makeBrowserWebviewLabel(tab.id)).catch(() => undefined)
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

      // 关闭所有 Tab
      closeAllTabs: () => {
        closeBrowserResources(get().tabs)
        set({
          tabs: [],
          activeTabId: null,
        })
      },

      // 关闭其他 Tab
      closeOtherTabs: (tabId: string) => {
        closeBrowserResources(get().tabs.filter((tab) => tab.id !== tabId))
        set((state) => ({
          tabs: state.tabs.filter((tab) => tab.id === tabId),
          activeTabId: tabId,
        }))
      },

      // 关闭右侧 Tab
      closeRightTabs: (tabId: string) => {
        set((state) => {
          const tabIndex = state.tabs.findIndex((tab) => tab.id === tabId)
          if (tabIndex === -1) return state

          const kept = state.tabs.slice(0, tabIndex + 1)
          const removed = state.tabs.slice(tabIndex + 1)

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

      // 关闭已保存的 Tab
      closeSavedTabs: () => {
        set((state) => {
          const kept = state.tabs.filter((tab) => tab.isDirty)
          const removed = state.tabs.filter((tab) => !tab.isDirty)

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

      updateBrowserTab: (tabId: string, updates: { url?: string; title?: string }) => {
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
