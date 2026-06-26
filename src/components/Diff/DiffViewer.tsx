/**
 * Diff 差异查看器组件（编排层）
 *
 * 职责：状态栏 + 渲染分流（短内容全量渲染 / 大文件 Virtuoso 虚拟化）+ 键盘导航 + 聚焦滚动。
 * 具体行渲染、行数据构建、变更索引计算已拆分到独立文件：
 * - splitRows.ts / UnifiedDiffRow.tsx / SplitDiffRowView.tsx / useChangeIndices.ts
 */

import { useMemo, useCallback, useRef, useState, useEffect } from 'react'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { computeDiff } from '@/services/diffService'
import { getLanguageFromPath, isHighlightableLanguage } from '@/utils/language'
import { logger } from '@/utils/logger'
import { useTranslation } from 'react-i18next'
import type { DiffChangeType, GitDiffEntry } from '@/types/git'
import { FileNavigator } from './FileNavigator'
import { useDiffKeyboard } from './useDiffKeyboard'
import { useChangeIndices } from './useChangeIndices'
import { buildSplitRows } from './splitRows'
import { UnifiedDiffRow } from './UnifiedDiffRow'
import { SplitDiffRowView } from './SplitDiffRowView'
import { ContentOmittedPlaceholder } from './ContentOmittedPlaceholder'
import { GUTTER_WIDTH } from './types'
import type { DiffViewMode } from './types'

export type { DiffViewMode } from './types'

/** 超过该行数才启用虚拟化；以下直接全量渲染（避免内嵌容器高度塌缩、保留原生横向滚动） */
const VIRTUALIZE_THRESHOLD = 500

interface DiffViewerProps {
  oldContent?: string
  newContent?: string
  changeType?: DiffChangeType
  statusHint?: {
    has_conflict: boolean
    message?: string
    current_view: string
  }
  showStatusHint?: boolean
  maxHeight?: string
  contentOmitted?: boolean
  viewMode?: DiffViewMode
  filePath?: string
  files?: GitDiffEntry[]
  activeFilePath?: string
  onFileSelect?: (filePath: string) => void
  /** 点击行回调（Ctrl+Click 时触发，传递行号） */
  onLineClick?: (lineNumber: number) => void
  onNextFile?: () => void
  onPrevFile?: () => void
  onOpenFile?: () => void
  onClose?: () => void
  /** 挂载后自动聚焦以启用键盘导航（全屏/主视图场景传 true，内嵌场景保持 false） */
  autoFocus?: boolean
}

export function DiffViewer({
  oldContent,
  newContent,
  changeType,
  statusHint,
  showStatusHint = true,
  maxHeight,
  contentOmitted = false,
  viewMode = 'unified',
  filePath,
  files,
  activeFilePath,
  onFileSelect,
  onLineClick,
  onNextFile,
  onPrevFile,
  onOpenFile,
  onClose,
  autoFocus = false,
}: DiffViewerProps) {
  const { t } = useTranslation('git')
  const [focusIndex, setFocusIndex] = useState(0)

  const language = useMemo(() => {
    if (!filePath) return undefined
    const lang = getLanguageFromPath(filePath)
    return isHighlightableLanguage(lang) ? lang : undefined
  }, [filePath])

  const effectiveOldContent = useMemo(() => {
    if (changeType === 'added' && oldContent === undefined) return ''
    return oldContent ?? ''
  }, [oldContent, changeType])

  const effectiveNewContent = useMemo(() => {
    if (changeType === 'deleted' && newContent === undefined) return ''
    return newContent ?? ''
  }, [newContent, changeType])

  const diff = useMemo(
    () => computeDiff(effectiveOldContent, effectiveNewContent),
    [effectiveOldContent, effectiveNewContent],
  )
  const splitRows = useMemo(
    () => (viewMode === 'split' ? buildSplitRows(diff.lines) : []),
    [viewMode, diff.lines],
  )

  // 变更块首行索引（unified / split 各自计算）
  const changeIndices = useChangeIndices(viewMode, diff.lines, splitRows)

  // 切换文件 / 视图导致变更集合变化时，重置聚焦位置
  useEffect(() => {
    setFocusIndex(0)
  }, [changeIndices])

  const handleNextChange = useCallback(() => {
    if (changeIndices.length === 0) return
    setFocusIndex((prev) => (prev + 1) % changeIndices.length)
  }, [changeIndices.length])

  const handlePrevChange = useCallback(() => {
    if (changeIndices.length === 0) return
    setFocusIndex((prev) => (prev - 1 + changeIndices.length) % changeIndices.length)
  }, [changeIndices.length])

  const containerRef = useDiffKeyboard({
    onNextFile,
    onPrevFile,
    onOpenFile,
    onClose,
    onNextChange: handleNextChange,
    onPrevChange: handlePrevChange,
    enabled: true,
    autoFocus,
  })

  logger.debug('[DiffViewer] 渲染:', {
    oldContentLength: oldContent?.length ?? 0,
    newContentLength: newContent?.length ?? 0,
    changeType,
    contentOmitted,
    language,
  })

  // 渲染分流：内嵌（maxHeight）或短内容 → 全量渲染；大文件 → 虚拟化
  const rowCount = viewMode === 'split' ? splitRows.length : diff.lines.length
  const shouldVirtualize = !maxHeight && rowCount > VIRTUALIZE_THRESHOLD

  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const focusedRowIndex = changeIndices[focusIndex]

  // 聚焦变更时自动滚动到该行
  useEffect(() => {
    if (focusedRowIndex == null) return
    if (shouldVirtualize) {
      virtuosoRef.current?.scrollToIndex({ index: focusedRowIndex, align: 'center' })
    } else {
      const el = scrollRef.current?.querySelector(`[data-row-index="${focusedRowIndex}"]`)
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', behavior: 'auto' })
      }
    }
  }, [focusedRowIndex, shouldVirtualize])

  if (contentOmitted) {
    return <ContentOmittedPlaceholder t={t} />
  }

  const renderUnifiedItem = (idx: number) => (
    <UnifiedDiffRow
      line={diff.lines[idx]}
      index={idx}
      focused={focusedRowIndex === idx}
      language={language}
    />
  )

  const renderSplitItem = (idx: number) => (
    <SplitDiffRowView
      row={splitRows[idx]}
      index={idx}
      focused={focusedRowIndex === idx}
      language={language}
      onLineClick={onLineClick}
    />
  )

  return (
    <div
      ref={containerRef}
      className="flex flex-col overflow-hidden font-mono text-sm outline-none"
      style={{ maxHeight, height: maxHeight ? undefined : '100%' }}
      tabIndex={0}
    >
      {files && files.length > 1 && activeFilePath && onFileSelect && (
        <FileNavigator files={files} activeFilePath={activeFilePath} onFileSelect={onFileSelect} />
      )}

      {showStatusHint && statusHint && (
        <div
          className={`px-4 py-2 border-b flex items-center gap-3 text-xs shrink-0 ${
            statusHint.has_conflict ? 'bg-yellow-500/10 border-yellow-500/20' : 'bg-blue-500/5 border-blue-500/10'
          }`}
        >
          {statusHint.has_conflict && <span className="text-yellow-600">⚠️</span>}
          <span className="text-text-secondary flex-1">
            {statusHint.message || (statusHint.has_conflict ? t('diff.note') : t('diff.info'))}
          </span>
          <span className="text-text-tertiary">{statusHint.current_view}</span>
        </div>
      )}

      <div className="flex items-center gap-4 px-4 py-1.5 bg-background-elevated border-b border-border text-xs shrink-0">
        <span className="text-green-500">+{diff.addedCount}</span>
        <span className="text-red-500">-{diff.removedCount}</span>
      </div>

      <div className="flex-1 overflow-hidden">
        {diff.lines.length === 0 ? (
          <div className="text-text-tertiary text-center py-8">{t('diff.noChanges')}</div>
        ) : viewMode === 'split' ? (
          <div className="h-full flex flex-col">
            {/* 表头 - 固定在顶部 */}
            <div className="flex shrink-0 bg-background-elevated border-b border-border text-xs text-text-tertiary">
              <div style={{ width: GUTTER_WIDTH }} className="shrink-0 px-2 py-1 text-right select-none border-r border-border-subtle">#</div>
              <div className="flex-1 px-3 py-1 font-sans min-w-0">{t('diff.oldVersion')}</div>
              <div style={{ width: GUTTER_WIDTH }} className="shrink-0 px-2 py-1 text-right select-none border-r border-border-subtle">#</div>
              <div className="flex-1 px-3 py-1 font-sans min-w-0">{t('diff.newVersion')}</div>
            </div>

            {shouldVirtualize ? (
              <Virtuoso
                ref={virtuosoRef}
                totalCount={splitRows.length}
                itemContent={renderSplitItem}
                style={{ height: '100%' }}
              />
            ) : (
              <div ref={scrollRef} className="flex-1 overflow-auto">
                {splitRows.map((_, idx) => (
                  <div key={idx}>{renderSplitItem(idx)}</div>
                ))}
              </div>
            )}
          </div>
        ) : shouldVirtualize ? (
          <Virtuoso
            ref={virtuosoRef}
            totalCount={diff.lines.length}
            itemContent={renderUnifiedItem}
            style={{ height: '100%' }}
          />
        ) : (
          <div ref={scrollRef} className="h-full overflow-auto">
            {diff.lines.map((_, idx) => (
              <div key={idx}>{renderUnifiedItem(idx)}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function SimpleDiffViewer({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  return <DiffViewer oldContent={oldContent} newContent={newContent} showStatusHint={false} />
}
