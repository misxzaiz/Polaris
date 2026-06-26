/**
 * Diff 差异查看器组件
 *
 * 支持词级差异高亮和语法着色，提供 IDEA 级别的 diff 体验
 */

import { useMemo, useCallback, useRef, useState, useEffect } from 'react'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
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
  /** 点击行回调（Ctrl+Click 时触发，传递行号） */
  onLineClick?: (lineNumber: number) => void
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

  const diff = useMemo(() => computeDiff(effectiveOldContent, effectiveNewContent), [effectiveOldContent, effectiveNewContent])
  const splitRows = useMemo(() => viewMode === 'split' ? buildSplitRows(diff.lines) : [], [viewMode, diff.lines])

  // 计算所有变更行的索引
  const changeIndices = useMemo(() => {
    const indices: number[] = []
    splitRows.forEach((row, idx) => {
      if (row.oldType === 'removed' || row.newType === 'added') {
        indices.push(idx)
      }
    })
    return indices
  }, [splitRows])

  // 跳到下一个变更点
  const handleNextChange = useCallback(() => {
    if (changeIndices.length === 0) return
    setFocusIndex(prev => (prev + 1) % changeIndices.length)
  }, [changeIndices.length])

  // 跳到上一个变更点
  const handlePrevChange = useCallback(() => {
    if (changeIndices.length === 0) return
    setFocusIndex(prev => (prev - 1 + changeIndices.length) % changeIndices.length)
  }, [changeIndices.length])

  const containerRef = useDiffKeyboard({
    onNextFile,
    onPrevFile,
    onOpenFile,
    onClose,
    onNextChange: handleNextChange,
    onPrevChange: handlePrevChange,
    enabled: true,
  })

  logger.debug('[DiffViewer] 渲染:', {
    oldContentLength: oldContent?.length ?? 0,
    newContentLength: newContent?.length ?? 0,
    changeType,
    contentOmitted,
    language,
    timestamp: new Date().toISOString(),
  })

  const virtuosoRef = useRef<VirtuosoHandle>(null)

  // 聚焦变更时自动滚动到该位置
  useEffect(() => {
    if (changeIndices.length === 0) return
    const targetIdx = changeIndices[focusIndex]
    if (targetIdx == null) return
    virtuosoRef.current?.scrollToIndex({ index: targetIdx, align: 'center' })
  }, [focusIndex, changeIndices])

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

            {/* 虚拟化左右面板 */}
            <Virtuoso
              ref={virtuosoRef}
              totalCount={splitRows.length}
              itemContent={(idx) => {
                const row = splitRows[idx]
                const isFocused = changeIndices[focusIndex] === idx

                const renderSide = (side: 'left' | 'right') => {
                  const lineNum = side === 'right' ? row.newLineNumber : row.oldLineNumber
                  const rowType = side === 'right' ? row.newType : row.oldType
                  const content = side === 'right' ? row.newContent : row.oldContent
                  const isChangedRow = row.oldType === 'removed' && row.newType === 'added'

                  let bgClass = ''
                  if (side === 'right') {
                    if (isChangedRow) bgClass = 'bg-green-500/8'
                    else if (rowType === 'added') bgClass = 'bg-green-500/10'
                    else if (rowType === 'empty') bgClass = 'bg-background-elevated/30'
                  } else {
                    if (isChangedRow) bgClass = 'bg-red-500/8'
                    else if (rowType === 'removed') bgClass = 'bg-red-500/10'
                    else if (rowType === 'empty') bgClass = 'bg-background-elevated/30'
                  }

                  if (isFocused) {
                    bgClass = 'bg-primary/15 ring-1 ring-inset ring-primary/30'
                  }

                  if (rowType === 'folded') {
                    return (
                      <div className="flex-1 flex flex-col overflow-hidden">
                        <div
                          className="px-3 py-1 text-xs text-text-tertiary italic text-center bg-background-elevated/50 whitespace-pre"
                        >
                          {content}
                        </div>
                      </div>
                    )
                  }

                  const mappedType: 'context' | 'added' | 'removed' | 'empty' = rowType

                  const handleClick = (e: React.MouseEvent) => {
                    if (e.ctrlKey || e.metaKey) {
                      const num = side === 'right' ? row.newLineNumber : row.oldLineNumber
                      if (num != null) {
                        onLineClick?.(num)
                      }
                    }
                  }

                  return (
                    <div className="flex flex-1 min-w-0 overflow-hidden">
                      <div
                        className="flex flex-col shrink-0 select-none overflow-hidden border-r border-border-subtle"
                        style={{ width: GUTTER_WIDTH }}
                      >
                        <div
                          className={`px-1.5 py-0.5 text-right text-xs text-text-tertiary ${
                            rowType === 'added' || rowType === 'removed'
                              ? side === 'right' ? 'bg-green-500/5' : 'bg-red-500/5'
                              : ''
                          }`}
                        >
                          {lineNum ?? (rowType === 'empty' ? '' : '\u00D7')}
                        </div>
                      </div>
                      <div
                        className={`flex-1 px-3 py-0.5 whitespace-pre inline-block min-w-full ${bgClass} cursor-pointer`}
                        onClick={handleClick}
                      >
                        <WordDiffSegment
                          oldText={content}
                          newText={content}
                          language={language}
                          type={mappedType}
                          isRight={side === 'right'}
                        />
                      </div>
                    </div>
                  )
                }

                return (
                  <div className="flex" style={{ height: 24 }}>
                    {renderSide('left')}
                    <div className="w-px bg-border shrink-0" />
                    {renderSide('right')}
                  </div>
                )
              }}
              style={{ height: '100%' }}
            />
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            totalCount={diff.lines.length}
            itemContent={(idx) => {
              const line = diff.lines[idx]
              const isFolded = line.content.startsWith('⋯') && line.content.endsWith('⋯')
              return (
                <div
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
            }}
            style={{ height: '100%', minWidth: 600 }}
          />
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
