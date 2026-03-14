/**
 * CenterStage - 中间编辑区组件
 *
 * 包含 TabBar 和 TabContent,支持 Editor 和 DiffViewer 切换
 */

import { ReactNode, useCallback, useState } from 'react'
import { X, FileDiff, FileText, Image as ImageIcon } from 'lucide-react'
import { useTabStore, Tab } from '@/stores/tabStore'
import { DiffViewer } from '@/components/Diff/DiffViewer'
import { EditorPanel } from '@/components/Editor'
import { TabContextMenu } from './TabContextMenu'
import { ImagePreview } from '@/components/Preview/ImagePreview'

interface TabBarProps {
  className?: string
}

/**
 * TabBar 组件
 */
export function TabBar({ className = '' }: TabBarProps) {
  const tabs = useTabStore((state) => state.tabs)
  const activeTabId = useTabStore((state) => state.activeTabId)
  const closeTab = useTabStore((state) => state.closeTab)
  const closeOtherTabs = useTabStore((state) => state.closeOtherTabs)
  const closeAllTabs = useTabStore((state) => state.closeAllTabs)
  const switchTab = useTabStore((state) => state.switchTab)

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean
    x: number
    y: number
    tabId: string
  }>({ visible: false, x: 0, y: 0, tabId: '' })

  // 获取 Tab 图标
  const getTabIcon = (tab: Tab) => {
    if (tab.type === 'diff') {
      return <FileDiff size={14} />
    }
    if (tab.type === 'preview') {
      return <ImageIcon size={14} />
    }
    return <FileText size={14} />
  }

  // 关闭 Tab 时阻止事件冒泡
  const handleClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation()
      closeTab(tabId)
    },
    [closeTab]
  )

  // 右键菜单处理
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.preventDefault()
      e.stopPropagation()
      setContextMenu({
        visible: true,
        x: e.clientX,
        y: e.clientY,
        tabId,
      })
    },
    []
  )

  if (tabs.length === 0) {
    return (
      <div className={`flex items-center justify-center h-10 bg-background-surface border-b border-border-subtle ${className}`}>
        <span className="text-xs text-text-tertiary">打开文件或查看差异</span>
      </div>
    )
  }

  return (
    <>
      <div
        className={`flex items-center gap-1 px-2 h-10 bg-background-surface border-b border-border-subtle overflow-x-auto ${className}`}
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => switchTab(tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
            className={`group flex items-center gap-2 px-3 py-1.5 rounded-t-md min-w-[120px] max-w-[200px] cursor-pointer transition-all select-none ${
              activeTabId === tab.id
                ? 'bg-background-base text-text-primary border-t-2 border-primary'
                : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
            }`}
          >
            {/* 图标 */}
            <span className="shrink-0">{getTabIcon(tab)}</span>

            {/* 标题 */}
            <span className="flex-1 text-xs font-medium truncate">{tab.title}</span>

            {/* 关闭按钮 */}
            {tab.closable && (
              <button
                onClick={(e) => handleClose(e, tab.id)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background-hover transition-all"
                title="关闭"
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* 右键菜单 */}
      <TabContextMenu
        visible={contextMenu.visible}
        x={contextMenu.x}
        y={contextMenu.y}
        tabId={contextMenu.tabId}
        onClose={() => setContextMenu({ ...contextMenu, visible: false })}
        onCloseTab={() => {
          closeTab(contextMenu.tabId)
        }}
        onCloseOthers={(tabId) => {
          closeOtherTabs(tabId)
        }}
        onCloseAll={() => {
          closeAllTabs()
        }}
      />
    </>
  )
}

interface TabContentProps {
  className?: string
}

/**
 * TabContent 组件 - 根据 activeTabId 渲染对应内容
 */
export function TabContent({ className = '' }: TabContentProps) {
  const activeTab = useTabStore((state) => state.getActiveTab())

  if (!activeTab) {
    return (
      <div
        className={`flex-1 flex items-center justify-center bg-background-base ${className}`}
      >
        <div className="text-center">
          <p className="text-sm text-text-secondary mb-2">没有打开的标签页</p>
          <p className="text-xs text-text-tertiary">
            从左侧文件浏览器打开文件,或在 Git 面板中查看差异
          </p>
        </div>
      </div>
    )
  }

  // 根据 Tab 类型渲染不同内容
  switch (activeTab.type) {
    case 'editor':
      return (
        <div className={`flex-1 flex flex-col overflow-hidden ${className}`}>
          <EditorPanel filePath={activeTab.filePath} />
        </div>
      )

    case 'diff':
      return (
        <div className={`flex-1 flex flex-col overflow-hidden ${className}`}>
          {/* Diff 头部 */}
          <div className="px-4 py-2 text-xs font-medium text-text-secondary bg-background-surface border-b border-border-subtle shrink-0">
            {activeTab.diffData?.file_path}
          </div>

          {/* Diff 内容 */}
          <div className="flex-1 overflow-auto">
            <DiffViewer
              oldContent={activeTab.diffData?.old_content}
              newContent={activeTab.diffData?.new_content}
              changeType={activeTab.diffData?.change_type}
              statusHint={activeTab.diffData?.status_hint}
            />
          </div>
        </div>
      )

    case 'preview':
      if (activeTab.metadata?.kind === 'image') {
        return (
          <div className={`flex-1 flex flex-col overflow-hidden ${className}`}>
            <ImagePreview filePath={activeTab.filePath} title={activeTab.title} />
          </div>
        )
      }
      return (
        <div className={`flex-1 flex items-center justify-center ${className}`}>
          <p className="text-sm text-text-tertiary">预览功能开发中...</p>
        </div>
      )

    default:
      return null
  }
}

interface CenterStageProps {
  children?: ReactNode
  className?: string
}

/**
 * CenterStage 主组件
 */
export function CenterStage({ children, className = '' }: CenterStageProps) {
  const tabs = useTabStore((state) => state.tabs)

  // 如果没有 Tab,不渲染 CenterStage,给右侧面板更多空间
  if (tabs.length === 0) {
    return null
  }

  return (
    <main className={`flex flex-col flex-1 overflow-hidden bg-background-base ${className}`}>
      <TabBar />
      <TabContent />
      {children}
    </main>
  )
}
