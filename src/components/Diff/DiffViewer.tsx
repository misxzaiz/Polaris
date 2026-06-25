/**
 * Diff 差异查看器组件
 *
 * 支持词级差异高亮和语法着色，提供 IDEA 级别的 diff 体验
 */

import { useMemo, useCallback, useRef } from 'react'
import { computeDiff } from '@/services/diffService'
import { getLanguageFromPath, isHighlightableLanguage } from '@/utils/language'
import { logger } from '@/utils/logger'
import { useTranslation } from 'react-i18next'
import type { DiffChangeType, GitDiffEntry } from '@/types/git'
import type { DiffLine } from '@/services/diffService'
import { WordDiffSegment } from './WordDiffSegment'
import { FileNavigator } from './FileNavigator'
import { useDiffKeyboard } from './useDiffKeyboard'

export type DiffViewMode = 'unified' | 'split'

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
  onNextFile?: () => void
  onPrevFile?: () => void
  onOpenFile?: () => void
  onClose?: () => void
}

type SplitSideType = 'context' | 'added' | 'removed' | 'empty' | 'folded'

interface SplitDiffRow {
  oldLineNumber: number | null
  newLineNumber: number | null
  oldContent: string
  newContent: string
  oldType: SplitSideType
  newType: SplitSideType
}

const isFoldedLine = (line: DiffLine) => line.content.startsWith('⋯') && line.content.endsWith('⋯')

function buildSplitRows(lines: DiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (isFoldedLine(line)) {
      rows.push({
        oldLineNumber: null,
        newLineNumber: null,
        oldContent: line.content,
        newContent: line.content,
        oldType: 'folded',
        newType: 'folded',
      })
      index++
      continue
    }

    if (line.type === 'context') {
      rows.push({
        oldLineNumber: line.oldLineNumber,
        newLineNumber: line.newLineNumber,
        oldContent: line.content,
        newContent: line.content,
        oldType: 'context',
        newType: 'context',
      })
      index++
      continue
    }

    if (line.type === 'removed') {
      const removedLines: DiffLine[] = []
      const addedLines: DiffLine[] = []

      while (index < lines.length && lines[index].type === 'removed') {
        removedLines.push(lines[index])
        index++
      }
      while (index < lines.length && lines[index].type === 'added') {
        addedLines.push(lines[index])
        index++
      }

      const rowCount = Math.max(removedLines.length, addedLines.length)
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
        const oldLine = removedLines[rowIndex]
        const newLine = addedLines[rowIndex]
        rows.push({
          oldLineNumber: oldLine?.oldLineNumber ?? null,
          newLineNumber: newLine?.newLineNumber ?? null,
          oldContent: oldLine?.content ?? '',
          newContent: newLine?.content ?? '',
          oldType: oldLine ? 'removed' : 'empty',
          newType: newLine ? 'added' : 'empty',
        })
      }
      continue
    }

    const addedLines: DiffLine[] = []
    while (index < lines.length && lines[index].type === 'added') {
      addedLines.push(lines[index])
      index++
    }

    for (const addedLine of addedLines) {
      rows.push({
        oldLineNumber: null,
        newLineNumber: addedLine.newLineNumber,
        oldContent: '',
        newContent: addedLine.content,
        oldType: 'empty',
        newType: 'added',
      })
    }
  }

  return rows
}

function ContentOmittedPlaceholder({ t }: { t: (key: string) => string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center">
      <svg className="w-12 h-12 text-text-tertiary mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
      <div className="text-text-secondary mb-2">{t('diff.fileTooLarge')}</div>
      <div className="text-text-tertiary text-sm">
        {t('diff.contentOmittedHint')}
      </div>
    </div>
  )
}

/** 行号列固定宽度 */
const GUTTER_WIDTH = '3.5rem'

/**
 * 渲染单侧的 diff 面板（左或右）
 */
function SplitSidePanel({
  rows,
  side,
  language,
  gutterRef,
  contentRef,
  onScroll,
}: {
  rows: SplitDiffRow[]
  side: 'left' | 'right'
  language: string | undefined
  gutterRef: React.RefObject<HTMLDivElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void
}) {
  const isRight = side === 'right'

  return (
    <div className="flex flex-1 min-w-0 overflow-hidden">
      {/* 行号列 - 固定宽度，不参与横向滚动 */}
      <div
        ref={gutterRef}
        className="flex flex-col shrink-0 select-none overflow-hidden border-r border-border-subtle"
        style={{ width: GUTTER_WIDTH }}
      >
        {rows.map((row, idx) => {
          const lineNum = isRight ? row.newLineNumber : row.oldLineNumber
          const rowType = isRight ? row.newType : row.oldType
          const isChanged = rowType === 'added' || rowType === 'removed'

          return (
            <div
              key={idx}
              className={`px-1.5 py-0.5 text-right text-xs text-text-tertiary ${
                isChanged
                  ? isRight ? 'bg-green-500/5' : 'bg-red-500/5'
                  : ''
              }`}
            >
              {lineNum ?? (rowType === 'empty' ? '' : '\u00D7')}
            </div>
          )
        })}
      </div>

      {/* 内容列 - 支持独立横向和垂直滚动 */}
      <div
        ref={contentRef}
        className="flex-1 overflow-auto"
        onScroll={onScroll}
      >
        <div className="min-w-full">
          {rows.map((row, idx) => {
            const rowType = isRight ? row.newType : row.oldType
            const content = isRight ? row.newContent : row.oldContent
            const isChangedRow = row.oldType === 'removed' && row.newType === 'added'

            let bgClass = ''
            if (isRight) {
              if (isChangedRow) bgClass = 'bg-green-500/8'
              else if (rowType === 'added') bgClass = 'bg-green-500/10'
              else if (rowType === 'empty') bgClass = 'bg-background-elevated/30'
            } else {
              if (isChangedRow) bgClass = 'bg-red-500/8'
              else if (rowType === 'removed') bgClass = 'bg-red-500/10'
              else if (rowType === 'empty') bgClass = 'bg-background-elevated/30'
            }

            if (rowType === 'folded') {
              return (
                <div
                  key={idx}
                  className="px-3 py-1 text-xs text-text-tertiary italic text-center bg-background-elevated/50 whitespace-pre"
                >
                  {content}
                </div>
              )
            }

            const mappedType: 'context' | 'added' | 'removed' | 'empty' =
              rowType === 'folded' ? 'context' : rowType

            return (
              <div key={idx} className={`px-3 py-0.5 whitespace-pre inline-block min-w-full ${bgClass}`}>
                <WordDiffSegment
                  oldText={content}
                  newText={content}
                  language={language}
                  type={mappedType}
                  isRight={isRight}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
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
  onNextFile,
  onPrevFile,
  onOpenFile,
  onClose,
}: DiffViewerProps) {
  const { t } = useTranslation('git')

  const containerRef = useDiffKeyboard({
    onNextFile,
    onPrevFile,
    onOpenFile,
    onClose,
    enabled: !!files && files.length > 1,
  })

  const language = useMemo(() => {
    if (!filePath) return undefined
    const lang = getLanguageFromPath(filePath)
    return isHighlightableLanguage(lang) ? lang : undefined
  }, [filePath])

  logger.debug('[DiffViewer] 渲染:', {
    oldContentLength: oldContent?.length ?? 0,
    newContentLength: newContent?.length ?? 0,
    changeType,
    contentOmitted,
    language,
    timestamp: new Date().toISOString(),
  })

  const effectiveOldContent = (() => {
    if (changeType === 'added' && oldContent === undefined) return ''
    return oldContent ?? ''
  })()

  const effectiveNewContent = (() => {
    if (changeType === 'deleted' && newContent === undefined) return ''
    return newContent ?? ''
  })()

  const diff = computeDiff(effectiveOldContent, effectiveNewContent)
  const splitRows = viewMode === 'split' ? buildSplitRows(diff.lines) : []

  // ========== Split 视图：左右面板垂直滚动联动 ==========
  const leftGutterRef = useRef<HTMLDivElement>(null)
  const rightGutterRef = useRef<HTMLDivElement>(null)
  const leftContentRef = useRef<HTMLDivElement>(null)
  const rightContentRef = useRef<HTMLDivElement>(null)
  const syncingRef = useRef(false)

  const handleLeftScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (syncingRef.current) return
    syncingRef.current = true
    const scrollTop = e.currentTarget.scrollTop
    const scrollLeft = e.currentTarget.scrollLeft
    // 右侧内容面板同步垂直滚动
    if (rightContentRef.current) rightContentRef.current.scrollTop = scrollTop
    // 右侧行号面板同步垂直滚动
    if (rightGutterRef.current) rightGutterRef.current.scrollTop = scrollTop
    // 左侧行号面板同步垂直滚动
    if (leftGutterRef.current) leftGutterRef.current.scrollTop = scrollTop
    // 右侧内容面板同步横向滚动（Shift+滚轮时）
    if (rightContentRef.current) rightContentRef.current.scrollLeft = scrollLeft
    requestAnimationFrame(() => { syncingRef.current = false })
  }, [])

  const handleRightScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (syncingRef.current) return
    syncingRef.current = true
    const scrollTop = e.currentTarget.scrollTop
    const scrollLeft = e.currentTarget.scrollLeft
    if (leftContentRef.current) leftContentRef.current.scrollTop = scrollTop
    if (leftGutterRef.current) leftGutterRef.current.scrollTop = scrollTop
    if (rightGutterRef.current) rightGutterRef.current.scrollTop = scrollTop
    if (leftContentRef.current) leftContentRef.current.scrollLeft = scrollLeft
    requestAnimationFrame(() => { syncingRef.current = false })
  }, [])

  if (contentOmitted) {
    return <ContentOmittedPlaceholder t={t} />
  }

  return (
    <div
      ref={containerRef}
      className="flex flex-col overflow-hidden font-mono text-sm"
      style={{ maxHeight, height: maxHeight ? undefined : '100%' }}
      tabIndex={-1}
    >
      {files && files.length > 1 && activeFilePath && onFileSelect && (
        <FileNavigator
          files={files}
          activeFilePath={activeFilePath}
          onFileSelect={onFileSelect}
        />
      )}

      {showStatusHint && statusHint && (
        <div className={`px-4 py-2 border-b flex items-center gap-3 text-xs shrink-0 ${
          statusHint.has_conflict
            ? 'bg-yellow-500/10 border-yellow-500/20'
            : 'bg-blue-500/5 border-blue-500/10'
        }`}>
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
        {diff.truncated && (
          <span className="text-text-tertiary ml-auto">
            {t('diff.showingLines', 'Showing {{count}} of {{total}} lines', {
              count: diff.lines.length,
              total: diff.totalLines,
            })}
          </span>
        )}
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

            {/* 左右面板 */}
            <div className="flex-1 flex overflow-hidden">
              <SplitSidePanel
                rows={splitRows}
                side="left"
                language={language}
                gutterRef={leftGutterRef}
                contentRef={leftContentRef}
                onScroll={handleLeftScroll}
              />
              {/* 中间分割线 */}
              <div className="w-px bg-border shrink-0" />
              <SplitSidePanel
                rows={splitRows}
                side="right"
                language={language}
                gutterRef={rightGutterRef}
                contentRef={rightContentRef}
                onScroll={handleRightScroll}
              />
            </div>
          </div>
        ) : (
          <div className="h-full overflow-auto">
            <div className="space-y-px min-w-[600px]">
              {diff.lines.map((line, idx) => {
                const isFolded = line.content.startsWith('⋯') && line.content.endsWith('⋯')
                return (
                  <div
                    key={idx}
                    className={`flex gap-0 px-0 py-0.5 ${
                      isFolded
                        ? 'bg-background-elevated/50 text-text-tertiary italic text-center justify-center'
                        : line.type === 'added'
                          ? 'bg-green-500/8'
                          : line.type === 'removed'
                            ? 'bg-red-500/8'
                            : ''
                    }`}
                  >
                    {!isFolded && (
                      <>
                        <span className="w-10 text-right text-text-tertiary shrink-0 select-none pr-1">
                          {line.oldLineNumber ?? ''}
                        </span>
                        <span className="w-10 text-right text-text-tertiary shrink-0 select-none pr-1">
                          {line.newLineNumber ?? ''}
                        </span>
                        <span
                          className={`w-5 shrink-0 select-none font-bold text-center ${
                            line.type === 'added'
                              ? 'text-green-500'
                              : line.type === 'removed'
                                ? 'text-red-500'
                                : 'text-text-tertiary'
                          }`}
                        >
                          {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                        </span>
                      </>
                    )}
                    <span
                      className={`flex-1 whitespace-pre ${
                        line.type === 'removed' && !isFolded ? 'text-text-tertiary line-through' : 'text-text-secondary'
                      }`}
                    >
                      {isFolded ? (
                        line.content
                      ) : (
                        <WordDiffSegment
                          oldText={line.content}
                          newText={line.content}
                          language={language}
                          type={line.type}
                        />
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function SimpleDiffViewer({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  return (
    <DiffViewer
      oldContent={oldContent}
      newContent={newContent}
      showStatusHint={false}
    />
  )
}
