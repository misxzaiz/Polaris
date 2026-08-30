/**
 * EditorOverlay - 窄窗口编辑器覆盖层
 *
 * 窄窗口（isCompact）下 CenterStage 被 !isCompact 门控不渲染，打开文件无反馈。
 * 本组件作为窄窗口下编辑器的渲染载体，从底部滑入覆盖聊天区，与 LeftPanelDrawer 同构。
 *
 * 设计：
 * - 复用 EditorPanel（内部订阅 fileEditorStore.currentFile），不重复加载逻辑
 * - 关闭只隐藏覆盖层，不销毁 tab —— 窗口拖宽后 CenterStage 接管同一批 tab
 * - 文件内容由上游 fileEditorStore.openFile 加载，本组件只负责显示
 * - min-w-0 必需：防止 CodeMirror 长行撑破 flex（与 CenterStage 同一修复）
 * - polaris-editor-overlay scope：窄窗口下隐藏 foldGutter 折叠槽列（省 ~20px 行号区宽度），
 *   键盘折叠（foldKeymap）仍可用；仅此覆盖层生效，宽窗口 CenterStage 不受影响
 */

import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useFileEditorStore } from '@/stores/fileEditorStore'
import { EditorPanel } from './EditorPanel'

interface EditorOverlayProps {
  /** 当前覆盖层绑定的文件路径（用于关闭时清理） */
  filePath: string
  /** 关闭回调 */
  onClose: () => void
}

export function EditorOverlay({ filePath, onClose }: EditorOverlayProps) {
  const { t } = useTranslation('common')
  const currentFile = useFileEditorStore((state) => state.currentFile)

  // Escape 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className="polaris-editor-overlay absolute inset-0 z-50 flex flex-col bg-background-base animate-in slide-in-from-bottom duration-280 [&_.cm-foldGutter]:hidden"
      role="dialog"
      aria-modal="true"
      aria-label={t('tabs.editor', { defaultValue: '编辑器' })}
    >
      {/* 顶部栏：文件名 + 关闭按钮（无 Tab 切换，单文件视图） */}
      <div className="flex items-center justify-between h-9 px-2 bg-background-elevated border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0 px-1">
          <span className="text-xs font-medium text-text-primary truncate">
            {currentFile?.name ?? filePath.split(/[/\\]/).pop() ?? ''}
          </span>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-md flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors shrink-0"
          title={t('buttons.close', { defaultValue: '关闭' })}
          aria-label={t('buttons.close', { defaultValue: '关闭' })}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 编辑器内容：复用 EditorPanel，min-w-0 防止 CM 长行撑破 */}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <EditorPanel />
      </div>
    </div>
  )
}
