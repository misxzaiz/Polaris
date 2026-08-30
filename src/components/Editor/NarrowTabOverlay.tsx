/**
 * NarrowTabOverlay - 窄窗口 Tab 覆盖层（CenterStage 的窄窗口替身）
 *
 * 窄窗口（isCompact）下 CenterStage 被 !isCompact 门控不渲染，打开文件/diff
 * 时 tab 静默创建无反馈。本组件作为窄窗口下 tab 的渲染载体，从底部滑入覆盖
 * 聊天区，与 LeftPanelDrawer 同构。信号（tabId）由 narrowTabStore 提供，
 * 本组件按 tab.type 分流渲染：
 * - editor → EditorPanel（订阅 fileEditorStore，复用缓冲/保存/LSP 全链路）
 * - diff   → DiffViewer（默认 unified 单栏：窄窗口 split 双栏每列过窄不可读）
 *
 * 设计：
 * - 关闭只清信号，不销毁 tab —— 窗口拖宽后 CenterStage 接管同一批 tab
 * - diff 的 viewMode 覆盖层内自维护（默认 unified），不污染 CenterStage 默认值
 * - min-w-0 必需：防止 CodeMirror / diff 长行撑破 flex（与 CenterStage 同一修复）
 * - z-[60]：高于 LeftPanelDrawer（z-50），从 Git 抽屉点 diff 时覆盖层在上层，
 *   Escape 只作用于最上层
 */

import { useEffect, useState } from 'react'
import { X, Rows3, Columns2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTabStore } from '@/stores/tabStore'
import { useNarrowTabStore } from '@/stores/narrowTabStore'
import { EditorPanel } from './EditorPanel'
import { DiffViewer } from '@/components/Diff/DiffViewer'

export function NarrowTabOverlay() {
  const { t } = useTranslation('common')
  const { t: tGit } = useTranslation('git')
  const narrowTabId = useNarrowTabStore((state) => state.narrowTabId)
  const closeNarrowTab = useNarrowTabStore((state) => state.closeNarrowTab)
  const tab = useTabStore((state) => state.tabs.find((tb) => tb.id === narrowTabId))

  // diff 视图模式：覆盖层内自维护，窄窗口默认 unified 单栏
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>('unified')

  // Escape 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeNarrowTab()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeNarrowTab])

  // 信号指向的 tab 已被关闭（或 store 重置）：自动收起覆盖层
  if (!tab) return null

  const title = tab.type === 'diff'
    ? (tab.diffData?.file_path ?? tab.title)
    : (tab.diffData ? tab.title : tab.filePath ? tab.filePath.split(/[/\\]/).pop()! : tab.title)

  return (
    <div
      className="polaris-editor-overlay absolute inset-0 z-[60] flex flex-col bg-background-base animate-in slide-in-from-bottom duration-280 [&_.cm-foldGutter]:hidden"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* 顶部栏：标题 + 操作按钮（无 Tab 切换，单 tab 视图） */}
      <div className="flex items-center justify-between h-9 px-2 bg-background-elevated border-b border-border shrink-0 gap-2">
        <span className="text-xs font-medium text-text-primary truncate min-w-0 flex-1 px-1" title={title}>
          {title}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {/* diff tab：unified/split 切换（与 CenterStage diff 头部同款） */}
          {tab.type === 'diff' && tab.diffData && (
            <div className="flex items-center bg-background-base border border-border rounded">
              <button
                type="button"
                onClick={() => setDiffViewMode('unified')}
                className={`p-1.5 transition-colors ${diffViewMode === 'unified' ? 'text-primary bg-primary/10' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'}`}
                title={tGit('diff.unifiedView')}
              >
                <Rows3 size={13} />
              </button>
              <button
                type="button"
                onClick={() => setDiffViewMode('split')}
                className={`p-1.5 transition-colors ${diffViewMode === 'split' ? 'text-primary bg-primary/10' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'}`}
                title={tGit('diff.splitView')}
              >
                <Columns2 size={13} />
              </button>
            </div>
          )}
          <button
            onClick={closeNarrowTab}
            className="w-7 h-7 rounded-md flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
            title={t('buttons.close', { defaultValue: '关闭' })}
            aria-label={t('buttons.close', { defaultValue: '关闭' })}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 内容区：按 tab.type 分流；min-w-0 防止长行撑破 flex */}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {tab.type === 'diff' && tab.diffData ? (
          <DiffViewer
            oldContent={tab.diffData.old_content}
            newContent={tab.diffData.new_content}
            changeType={tab.diffData.change_type}
            statusHint={tab.diffData.status_hint}
            contentOmitted={tab.diffData.content_omitted ?? false}
            viewMode={diffViewMode}
            filePath={tab.diffData.file_path}
            autoFocus
          />
        ) : (
          <EditorPanel />
        )}
      </div>
    </div>
  )
}
