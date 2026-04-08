/**
 * Tab Store
 *
 * 管理 Tab 状态,用于中间编辑区的 Tab 切换
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { GitDiffEntry } from '@/types/git'
import { useEditorBufferStore } from './editorBufferStore'

/** Tab 类型 */
export type TabType = 'editor' | 'diff' | 'preview'

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

interface TabState {
  tabs: Tab[]
  activeTabId: string | null
}

interface TabActions {
  // Tab 操作
  openEditorTab: (filePath: string, title?: string) => string
  openPreviewTab: (filePath: string, title?: string, metadata?: Record<string, any>) => string
  openDiffTab: (diff: GitDiffEntry) => string
  closeTab: (tabId: string) => void
  switchTab: (tabId: string) => void
  closeAllTabs: () => void
  closeOtherTabs: (tabId: string) => void
  closeRightTabs: (tabId: string) => void
  closeSavedTabs: () => void

  // Dirty 状态管理
  setTabDirty: (tabId: string, isDirty: boolean) => void
  getDirtyTabs: () => Tab[]
  hasDirtyTabs: () => boolean

  // 获取操作
  getActiveTab: () => Tab | null
  getTabById: (id: string) => Tab | undefined
}

export type TabStore = TabState & TabActions

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
      openDiffTab: (diff: GitDiffEntry) => {
        // 检查是否已存在相同文件的 Diff Tab
        const existingTab = get().tabs.find(
          (tab) => tab.type === 'diff' && tab.diffData?.file_path === diff.file_path
        )

        if (existingTab) {
          // 如果已存在,更新 diffData 并切换到该 Tab
          set((state) => ({
            tabs: state.tabs.map((tab) =>
              tab.id === existingTab.id
                ? { ...tab, diffData: diff }
                : tab
            ),
            activeTabId: existingTab.id,
          }))
          return existingTab.id
        }

        // 否则创建新 Tab
        const tabId = `diff-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        const fileName = diff.file_path.split('/').pop() || diff.file_path
        const newTab: Tab = {
          id: tabId,
          type: 'diff',
          title: `${fileName} (Diff)`,
          closable: true,
          diffData: diff,
        }

        set((state) => ({
          tabs: [...state.tabs, newTab],
          activeTabId: tabId,
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
            useEditorBufferStore.getState().removeBuffer(closedTab.filePath)
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
        set({
          tabs: [],
          activeTabId: null,
        })
      },

      // 关闭其他 Tab
      closeOtherTabs: (tabId: string) => {
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
              useEditorBufferStore.getState().removeBuffer(tab.filePath)
            }
          })

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
              useEditorBufferStore.getState().removeBuffer(tab.filePath)
            }
          })

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
      // 不持久化 tabs，每次启动都是空状态
      // 这样可以确保 hasOpenTabs 正确反映当前状态
    }
  )
)
