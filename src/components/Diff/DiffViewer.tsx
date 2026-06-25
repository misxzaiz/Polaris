/**
 * Diff 差异查看器组件
 *
 * 支持词级差异高亮和语法着色，提供 IDEA 级别的 diff 体验
 */

import { useMemo, useCallback } from 'react'
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
  /** 原始内容 */
  oldContent?: string
  /** 修改后内容 */
  newContent?: string
  /** 变更类型 */
  changeType?: DiffChangeType
  /** 状态提示 */
  statusHint?: {
    has_conflict: boolean
    message?: string
    current_view: string
  }
  /** 是否显示状态提示（默认 true） */
  showStatusHint?: boolean
  /** 最大高度（可选，用于限制高度） */
  maxHeight?: string
  /** 内容是否被省略（如文件过大） */
  contentOmitted?: boolean
  /** Diff 展示模式 */
  viewMode?: DiffViewMode
  /** 文件路径（用于语法高亮检测） */
  filePath?: string
  /** 多文件列表（用于文件导航） */
  files?: GitDiffEntry[]
  /** 当前选中的文件路径（用于文件导航） */
  activeFilePath?: string
  /** 文件选择回调（用于文件导航） */
  onFileSelect?: (filePath: string) => void
  /** 下一个文件回调（键盘快捷键） */
  onNextFile?: () => void
  /** 上一个文件回调（键盘快捷键） */
  onPrevFile?: () => void
  /** 打开文件编辑器回调（键盘快捷键） */
  onOpenFile?: () => void
  /** 关闭 diff 视图回调（键盘快捷键） */
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

/**
 * 内容省略时的提示组件
 */
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

/**
 * Diff 查看器组件
 * 支持词级差异高亮、语法着色和文件导航
 */
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

  // 键盘快捷键
  const containerRef = useDiffKeyboard({
    onNextFile,
    onPrevFile,
    onOpenFile,
    onClose,
    enabled: !!files && files.length > 1,
  })

  // 检测语言
  const language = useMemo(() => {
    if (!filePath) return undefined
    const lang = getLanguageFromPath(filePath)
    return isHighlightableLanguage(lang) ? lang : undefined
  }, [filePath])

  // 调试日志（仅在开发环境）
  logger.debug('[DiffViewer] 渲染:', {
    oldContentLength: oldContent?.length ?? 0,
    newContentLength: newContent?.length ?? 0,
    changeType,
    contentOmitted,
    language,
    timestamp: new Date().toISOString(),
  })

  // 根据 change_type 处理 undefined
  const effectiveOldContent = (() => {
    if (changeType === 'added' && oldContent === undefined) {
      return ''
    }
    return oldContent ?? ''
  })()

  const effectiveNewContent = (() => {
    if (changeType === 'deleted' && newContent === undefined) {
      return ''
    }
    return newContent ?? ''
  })()

  const diff = computeDiff(effectiveOldContent, effectiveNewContent)
  const splitRows = viewMode === 'split' ? buildSplitRows(diff.lines) : []

  // 渲染 split 视图中的变更行对（带词级差异）
  const renderChangedRow = useCallback(
    (row: SplitDiffRow, idx: number) => {
      const hasChange = row.oldType === 'removed' || row.newType === 'added'
      const isChangedRow = row.oldType === 'removed' && row.newType === 'added'

      return (
        <div
          key={idx}
          className="grid grid-cols-[4rem_minmax(16rem,1fr)_1px_4rem_minmax(16rem,1fr)]"
        >
          {/* 左侧行号 */}
          <span
            className={`px-2 py-0.5 text-right text-text-tertiary shrink-0 select-none border-r border-border-subtle ${
              hasChange ? 'bg-red-500/5' : ''
            }`}
          >
            {row.oldLineNumber ?? (row.oldType === 'empty' ? '' : '×')}
          </span>

          {/* 左侧内容 */}
          <span
            className={`px-3 py-0.5 ${
              isChangedRow
                ? 'bg-red-500/8'
                : row.oldType === 'removed'
                  ? 'bg-red-500/10'
                  : row.oldType === 'empty'
                    ? 'bg-background-elevated/30'
                    : ''
            }`}
          >
            {isChangedRow ? (
              <WordDiffSegment
                oldText={row.oldContent}
                newText={row.newContent}
                language={language}
                type="removed"
                isRight={false}
              />
            ) : (
              <WordDiffSegment
                oldText={row.oldContent}
                newText={row.oldContent}
                language={language}
                type={row.oldType === 'empty' ? 'empty' : row.oldType === 'folded' ? 'context' : row.oldType}
                isRight={false}
              />
            )}
          </span>

          {/* 中间分割线 */}
          <div className="bg-border-subtle" />

          {/* 右侧行号 */}
          <span
            className={`px-2 py-0.5 text-right text-text-tertiary shrink-0 select-none border-l border-border-subtle ${
              hasChange ? 'bg-green-500/5' : ''
            }`}
          >
            {row.newLineNumber ?? (row.newType === 'empty' ? '' : '×')}
          </span>

          {/* 右侧内容 */}
          <span
            className={`px-3 py-0.5 ${
              isChangedRow
                ? 'bg-green-500/8'
                : row.newType === 'added'
                  ? 'bg-green-500/10'
                  : row.newType === 'empty'
                    ? 'bg-background-elevated/30'
                    : ''
            }`}
          >
            {isChangedRow ? (
              <WordDiffSegment
                oldText={row.oldContent}
                newText={row.newContent}
                language={language}
                type="added"
                isRight={true}
              />
            ) : (
              <WordDiffSegment
                oldText={row.newContent}
                newText={row.newContent}
                language={language}
                type={row.newType === 'empty' ? 'empty' : row.newType === 'folded' ? 'context' : row.newType}
                isRight={true}
              />
            )}
          </span>
        </div>
      )
    },
    [language]
  )

  // 如果内容被省略，显示提示信息
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
      {/* 文件导航（多文件时显示） */}
      {files && files.length > 1 && activeFilePath && onFileSelect && (
        <FileNavigator
          files={files}
          activeFilePath={activeFilePath}
          onFileSelect={onFileSelect}
        />
      )}

      {/* 状态提示（可选） */}
      {showStatusHint && statusHint && (
        <div className={`px-4 py-2 border-b flex items-center gap-3 text-xs shrink-0 ${
          statusHint.has_conflict
            ? 'bg-yellow-500/10 border-yellow-500/20'
            : 'bg-blue-500/5 border-blue-500/10'
        }`}>
          {statusHint.has_conflict && (
            <span className="text-yellow-600">⚠️</span>
          )}
          <span className="text-text-secondary flex-1">
            {statusHint.message || (statusHint.has_conflict ? t('diff.note') : t('diff.info'))}
          </span>
          <span className="text-text-tertiary">
            {statusHint.current_view}
          </span>
        </div>
      )}

      {/* 差异摘要 */}
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

      {/* 差异内容 */}
      <div className="flex-1 overflow-auto">
        {diff.lines.length === 0 ? (
          <div className="text-text-tertiary text-center py-8">{t('diff.noChanges')}</div>
        ) : viewMode === 'split' ? (
          <div className="min-w-[900px]">
            {/* 表头 */}
            <div className="grid grid-cols-[4rem_minmax(16rem,1fr)_1px_4rem_minmax(16rem,1fr)] sticky top-0 z-10 bg-background-elevated border-b border-border text-xs text-text-tertiary">
              <span className="px-2 py-1 text-right select-none">#</span>
              <span className="px-3 py-1 font-sans">{t('diff.oldVersion')}</span>
              <div />
              <span className="px-2 py-1 text-right select-none">#</span>
              <span className="px-3 py-1 font-sans">{t('diff.newVersion')}</span>
            </div>

            {/* 行内容 */}
            <div className="space-y-px">
              {splitRows.map((row, idx) => {
                const rowIsFolded = row.oldType === 'folded' && row.newType === 'folded'
                if (rowIsFolded) {
                  return (
                    <div
                      key={idx}
                      className="grid grid-cols-[4rem_minmax(16rem,1fr)_1px_4rem_minmax(16rem,1fr)] bg-background-elevated/50"
                    >
                      <span className="col-span-5 px-3 py-1 text-center text-text-tertiary italic text-xs">
                        {row.oldContent}
                      </span>
                    </div>
                  )
                }
                return renderChangedRow(row, idx)
              })}
            </div>
          </div>
        ) : (
          /* Unified 视图 */
          <div className="space-y-px">
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
                      {/* 旧行号 */}
                      <span className="w-10 text-right text-text-tertiary shrink-0 select-none pr-1">
                        {line.oldLineNumber ?? ''}
                      </span>
                      {/* 新行号 */}
                      <span className="w-10 text-right text-text-tertiary shrink-0 select-none pr-1">
                        {line.newLineNumber ?? ''}
                      </span>
                      {/* 标记 */}
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
                  {/* 内容 */}
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
        )}
      </div>
    </div>
  )
}

/**
 * 简化版 Diff 查看器 - 不显示状态提示
 * 为了向后兼容保留的别名
 */
export function SimpleDiffViewer({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  return (
    <DiffViewer
      oldContent={oldContent}
      newContent={newContent}
      showStatusHint={false}
    />
  )
}
