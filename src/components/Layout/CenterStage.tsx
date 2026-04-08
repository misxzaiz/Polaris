/**
 * CenterStage - 中间编辑区组件
 *
 * 包含 TabBar 和 TabContent,支持 Editor 和 DiffViewer 切换
 */

import { ReactNode, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, FileDiff, FileText, Image as ImageIcon } from 'lucide-react'
import { useTabStore, Tab } from '@/stores/tabStore'
import { useFileEditorStore } from '@/stores/fileEditorStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { DiffViewer } from '@/components/Diff/DiffViewer'
import { EditorPanel, BreadcrumbBar } from '@/components/Editor'
import { TabContextMenu } from './TabContextMenu'
import { ImagePreview } from '@/components/Preview/ImagePreview'
import { UnsavedDialog } from '@/components/Common/UnsavedDialog'
import { useToastStore } from '@/stores/toastStore'

interface TabBarProps {
  className?: string
}

/** 未保存确认对话框状态 */
interface UnsavedDialogState {
  visible: boolean
  tabId: string
  fileName: string
}

/**
 * TabBar 组件
 */
export function TabBar({ className = '' }: TabBarProps) {
  const { t } = useTranslation('common')
  const tabs = useTabStore((state) => state.tabs)
  const activeTabId = useTabStore((state) => state.activeTabId)
  const closeTab = useTabStore((state) => state.closeTab)
  const setTabDirty = useTabStore((state) => state.setTabDirty)
  const closeOtherTabs = useTabStore((state) => state.closeOtherTabs)
  const closeAllTabs = useTabStore((state) => state.closeAllTabs)
  const closeRightTabs = useTabStore((state) => state.closeRightTabs)
  const closeSavedTabs = useTabStore((state) => state.closeSavedTabs)
  const switchTab = useTabStore((state) => state.switchTab)

  // 文件编辑器状态
  const currentFile = useFileEditorStore((state) => state.currentFile)
  const saveFile = useFileEditorStore((state) => state.saveFile)

  // 工作区路径（计算相对路径用）
  const currentWorkspace = useWorkspaceStore((state) => {
    const ws = state.workspaces.find(w => w.id === state.currentWorkspaceId)
    return ws || null
  })

  // Toast 通知
  const toast = useToastStore()

  // 未保存确认对话框状态
  const [unsavedDialog, setUnsavedDialog] = useState<UnsavedDialogState>({
    visible: false,
    tabId: '',
    fileName: '',
  })
  const [isSaving, setIsSaving] = useState(false)

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

  // 检查 Tab 是否有未保存更改
  const checkTabDirty = useCallback((tab: Tab): boolean => {
    // 只有 editor 类型的 Tab 才有 dirty 状态
    if (tab.type === 'editor' && tab.filePath) {
      // 检查是否与当前编辑器文件匹配
      if (currentFile?.path === tab.filePath && currentFile.isModified) {
        return true
      }
      // 也检查 Tab 自身的 dirty 标志
      if (tab.isDirty) {
        return true
      }
    }
    return false
  }, [currentFile])

  // 同步编辑器修改状态到 Tab
  const syncEditorDirtyToTab = useCallback((tab: Tab) => {
    if (tab.type === 'editor' && tab.filePath && currentFile?.path === tab.filePath) {
      const isDirty = currentFile.isModified
      if (tab.isDirty !== isDirty) {
        setTabDirty(tab.id, isDirty)
      }
    }
  }, [currentFile, setTabDirty])

  // 关闭 Tab 时检查未保存状态
  const handleClose = useCallback(
    (e: React.MouseEvent, tab: Tab) => {
      e.stopPropagation()

      // 同步 dirty 状态
      syncEditorDirtyToTab(tab)

      // 检查是否有未保存更改
      if (checkTabDirty(tab)) {
        setUnsavedDialog({
          visible: true,
          tabId: tab.id,
          fileName: tab.title,
        })
      } else {
        closeTab(tab.id)
      }
    },
    [closeTab, checkTabDirty, syncEditorDirtyToTab]
  )

  // 保存并关闭
  const handleSaveAndClose = useCallback(async () => {
    setIsSaving(true)
    try {
      await saveFile()
      // 保存成功后关闭 Tab
      closeTab(unsavedDialog.tabId)
      // 重置编辑器状态
      setTabDirty(unsavedDialog.tabId, false)
      setUnsavedDialog({ visible: false, tabId: '', fileName: '' })
      toast.success(t('messages.fileSaved', { ns: 'common' }) || '文件已保存')
    } catch (error) {
      toast.error(t('messages.saveFailed', { ns: 'common' }) || '保存失败')
      // 保存失败时保持对话框打开
    } finally {
      setIsSaving(false)
    }
  }, [saveFile, closeTab, unsavedDialog.tabId, setTabDirty, toast, t])

  // 不保存直接关闭
  const handleDontSave = useCallback(() => {
    closeTab(unsavedDialog.tabId)
    setTabDirty(unsavedDialog.tabId, false)
    setUnsavedDialog({ visible: false, tabId: '', fileName: '' })
  }, [closeTab, unsavedDialog.tabId, setTabDirty])

  // 取消关闭
  const handleCancelClose = useCallback(() => {
    setUnsavedDialog({ visible: false, tabId: '', fileName: '' })
  }, [])

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
        <span className="text-xs text-text-tertiary">{t('tabs.openFileOrDiff')}</span>
      </div>
    )
  }

  return (
    <>
      <div
        className={`flex items-center gap-1 px-2 h-10 bg-background-surface border-b border-border-subtle overflow-x-auto ${className}`}
      >
        {tabs.map((tab) => {
          const isDirty = checkTabDirty(tab)
          return (
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

              {/* Dirty 指示器或关闭按钮 */}
              {tab.closable && (
                <button
                  onClick={(e) => handleClose(e, tab)}
                  className={`p-0.5 rounded transition-all ${
                    isDirty
                      ? 'opacity-100 hover:bg-background-hover'
                      : 'opacity-0 group-hover:opacity-100 hover:bg-background-hover'
                  }`}
                  title={isDirty ? t('tabs.unsavedChanges') : t('tabs.close')}
                >
                  {isDirty ? (
                    <span className="w-2.5 h-2.5 rounded-full bg-warning block" />
                  ) : (
                    <X size={12} />
                  )}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* 右键菜单 */}
      <TabContextMenu
        visible={contextMenu.visible}
        x={contextMenu.x}
        y={contextMenu.y}
        tabId={contextMenu.tabId}
        onClose={() => setContextMenu({ ...contextMenu, visible: false })}
        onCloseTab={() => {
          // 右键菜单关闭也需要检查 dirty 状态
          const tab = tabs.find(t => t.id === contextMenu.tabId)
          if (tab) {
            syncEditorDirtyToTab(tab)
            if (checkTabDirty(tab)) {
              setUnsavedDialog({
                visible: true,
                tabId: tab.id,
                fileName: tab.title,
              })
            } else {
              closeTab(contextMenu.tabId)
            }
          }
        }}
        onCloseOthers={(tabId) => {
          // 检查其他 Tab 是否有 dirty 的
          const otherTabs = tabs.filter(t => t.id !== tabId)
          const dirtyTabs = otherTabs.filter(t => checkTabDirty(t))
          if (dirtyTabs.length > 0) {
            // 有未保存的 Tab，显示确认对话框
            // 由于涉及多个 Tab，暂时直接关闭所有（后续可增强为批量处理）
            closeOtherTabs(tabId)
          } else {
            closeOtherTabs(tabId)
          }
        }}
        onCloseAll={() => {
          const dirtyTabs = tabs.filter(t => checkTabDirty(t))
          if (dirtyTabs.length > 0) {
            closeAllTabs()
          } else {
            closeAllTabs()
          }
        }}
        onCloseRight={closeRightTabs}
        onCloseSaved={closeSavedTabs}
        onCopyPath={(tabId) => {
          const tab = tabs.find(t => t.id === tabId)
          if (tab?.filePath) {
            navigator.clipboard.writeText(tab.filePath)
            toast.addToast({ title: '复制成功', message: '已复制文件路径', type: 'success' })
          }
        }}
        onCopyRelativePath={(tabId) => {
          const tab = tabs.find(t => t.id === tabId)
          if (tab?.filePath && currentWorkspace?.path) {
            const relative = tab.filePath.replace(currentWorkspace.path, '').replace(/^[/\\]/, '')
            navigator.clipboard.writeText(relative)
            toast.addToast({ title: '复制成功', message: '已复制相对路径', type: 'success' })
          }
        }}
      />

      {/* 未保存确认对话框 */}
      {unsavedDialog.visible && (
        <UnsavedDialog
          fileName={unsavedDialog.fileName}
          onSave={handleSaveAndClose}
          onDontSave={handleDontSave}
          onCancel={handleCancelClose}
          isSaving={isSaving}
        />
      )}
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
  const { t } = useTranslation('common')
  const activeTab = useTabStore((state) => state.getActiveTab())
  const switchToFile = useFileEditorStore((state) => state.switchToFile)

  // Tab 切换时确保 fileEditorStore 加载正确的文件
  useEffect(() => {
    if (activeTab?.type === 'editor' && activeTab.filePath) {
      const name = activeTab.title || activeTab.filePath.split('/').pop() || ''
      switchToFile(activeTab.filePath, name)
    }
  }, [activeTab?.id, activeTab?.type, activeTab?.filePath, switchToFile])

  if (!activeTab) {
    return (
      <div
        className={`flex-1 flex items-center justify-center bg-background-base ${className}`}
      >
        <div className="text-center">
          <p className="text-sm text-text-secondary mb-2">{t('tabs.noOpenTabs')}</p>
          <p className="text-xs text-text-tertiary">
            {t('tabs.openFileHint')}
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
          <p className="text-sm text-text-tertiary">{t('tabs.previewInDevelopment')}</p>
        </div>
      )

    default:
      return null
  }
}

interface CenterStageProps {
  children?: ReactNode
  className?: string
  /** 是否填充剩余空间（当右侧没有其他面板时）- CenterStage 始终填充，此 prop 仅为接口一致性 */
  fillRemaining?: boolean
}

/**
 * CenterStage 主组件
 * 始终使用 flex-1 填充剩余空间
 */
export function CenterStage({ children, className = '' }: CenterStageProps) {
  const tabs = useTabStore((state) => state.tabs)

  // 如果没有 Tab,不渲染 CenterStage,让右侧面板填充空间
  if (tabs.length === 0) {
    return null
  }

  // CenterStage 本身就有 flex-1，始终填充可用空间
  return (
    <main className={`flex flex-col flex-1 overflow-hidden bg-background-base ${className}`}>
      <TabBar />
      <BreadcrumbBar />
      <TabContent />
      {children}
    </main>
  )
}
