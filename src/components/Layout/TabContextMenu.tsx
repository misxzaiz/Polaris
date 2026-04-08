/**
 * TabContextMenu - Tab 右键菜单组件
 */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

interface TabContextMenuProps {
  visible: boolean
  x: number
  y: number
  onClose: () => void
  onCloseTab: () => void
  onCloseOthers: (tabId: string) => void
  onCloseAll: () => void
  onCloseRight?: (tabId: string) => void
  onCloseSaved?: () => void
  onCopyPath?: (tabId: string) => void
  onCopyRelativePath?: (tabId: string) => void
  tabId: string
}

export function TabContextMenu({
  visible,
  x,
  y,
  onClose,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
  onCloseRight,
  onCloseSaved,
  onCopyPath,
  onCopyRelativePath,
  tabId,
}: TabContextMenuProps) {
  const { t } = useTranslation('common')
  const menuRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭菜单
  useEffect(() => {
    if (!visible) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [visible, onClose])

  if (!visible) return null

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] bg-background-elevated border border-border rounded-md shadow-lg py-1"
      style={{ left: `${x}px`, top: `${y}px` }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 关闭操作 */}
      <button
        onClick={() => {
          onCloseTab()
          onClose()
        }}
        className="w-full px-4 py-2 text-left text-sm text-text-primary hover:bg-background-hover transition-colors"
      >
        {t('tabs.close')}
      </button>
      <button
        onClick={() => {
          onCloseOthers(tabId)
          onClose()
        }}
        className="w-full px-4 py-2 text-left text-sm text-text-primary hover:bg-background-hover transition-colors"
      >
        {t('tabs.closeOthers')}
      </button>
      {onCloseRight && (
        <button
          onClick={() => {
            onCloseRight(tabId)
            onClose()
          }}
          className="w-full px-4 py-2 text-left text-sm text-text-primary hover:bg-background-hover transition-colors"
        >
          {t('tabs.closeRight', '关闭右侧标签页')}
        </button>
      )}
      {onCloseSaved && (
        <button
          onClick={() => {
            onCloseSaved()
            onClose()
          }}
          className="w-full px-4 py-2 text-left text-sm text-text-primary hover:bg-background-hover transition-colors"
        >
          {t('tabs.closeSaved', '关闭已保存的标签页')}
        </button>
      )}
      <div className="my-1 border-t border-border-subtle" />
      <button
        onClick={() => {
          onCloseAll()
          onClose()
        }}
        className="w-full px-4 py-2 text-left text-sm text-text-primary hover:bg-background-hover transition-colors"
      >
        {t('tabs.closeAll')}
      </button>

      {/* 路径操作（仅 editor tab 有 filePath 时显示） */}
      {(onCopyPath || onCopyRelativePath) && (
        <>
          <div className="my-1 border-t border-border-subtle" />
          {onCopyPath && (
            <button
              onClick={() => {
                onCopyPath(tabId)
                onClose()
              }}
              className="w-full px-4 py-2 text-left text-sm text-text-primary hover:bg-background-hover transition-colors"
            >
              {t('tabs.copyPath', '复制文件路径')}
            </button>
          )}
          {onCopyRelativePath && (
            <button
              onClick={() => {
                onCopyRelativePath(tabId)
                onClose()
              }}
              className="w-full px-4 py-2 text-left text-sm text-text-primary hover:bg-background-hover transition-colors"
            >
              {t('tabs.copyRelativePath', '复制相对路径')}
            </button>
          )}
        </>
      )}
    </div>
  )
}
