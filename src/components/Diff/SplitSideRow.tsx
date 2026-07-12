/**
 * Split（并排）视图的单元格组件
 *
 * 每侧拆分为两列独立渲染：
 * - SplitGutterCell：行号单元格，位于「不参与横向滚动」的固定行号列中（代码不会盖到其上）。
 * - SplitCodeCell：代码单元格，位于横向滚动的代码列中，含词级高亮。
 * 两列用相同的固定行高（SPLIT_ROW_HEIGHT）保证逐行对齐。
 */

import { memo } from 'react'
import type { SplitDiffRow, SplitSideType } from './splitRows'
import { isChangedRow } from './splitRows'
import { WordDiffSegment } from './WordDiffSegment'

/** Split 行固定高度（px）——行号列与代码列共用，保证对齐 */
export const SPLIT_ROW_HEIGHT = 22

interface CellProps {
  row: SplitDiffRow
  side: 'left' | 'right'
  focused: boolean
}

/** 行号单元格（固定行号列内） */
function SplitGutterCellImpl({ row, side, focused }: CellProps) {
  const isRight = side === 'right'
  const lineNum = isRight ? row.newLineNumber : row.oldLineNumber
  const rowType = isRight ? row.newType : row.oldType
  const isChanged = rowType === 'added' || rowType === 'removed'

  const bg = focused
    ? 'bg-primary/15'
    : isChanged
      ? isRight ? 'bg-green-500/10' : 'bg-red-500/10'
      : ''

  return (
    <div
      className={`flex items-center justify-end px-2 text-xs text-text-tertiary select-none ${bg}`}
      style={{ height: SPLIT_ROW_HEIGHT }}
    >
      {lineNum ?? (rowType === 'empty' ? '' : '×')}
    </div>
  )
}

/** 计算代码单元格背景色 */
function codeBgClass(side: 'left' | 'right', rowType: SplitSideType, changed: boolean, focused: boolean): string {
  if (focused) return 'bg-primary/15'
  if (side === 'right') {
    if (changed) return 'bg-green-500/8'
    if (rowType === 'added') return 'bg-green-500/10'
    if (rowType === 'empty') return 'bg-background-elevated/30'
  } else {
    if (changed) return 'bg-red-500/8'
    if (rowType === 'removed') return 'bg-red-500/10'
    if (rowType === 'empty') return 'bg-background-elevated/30'
  }
  return ''
}

interface CodeCellProps extends CellProps {
  index: number
  language?: string
  onLineClick?: (lineNumber: number) => void
}

/** 代码单元格（横向滚动的代码列内） */
function SplitCodeCellImpl({ row, side, index, focused, language, onLineClick }: CodeCellProps) {
  const isRight = side === 'right'
  const rowType = isRight ? row.newType : row.oldType
  const lineNum = isRight ? row.newLineNumber : row.oldLineNumber
  const changed = isChangedRow(row)

  if (rowType === 'folded') {
    return (
      <div
        data-row-index={index}
        className="flex items-center min-w-full px-3 text-xs text-text-tertiary italic bg-background-elevated/50 whitespace-pre"
        style={{ height: SPLIT_ROW_HEIGHT }}
      >
        {isRight ? row.newContent : row.oldContent}
      </div>
    )
  }

  const segType = changed ? 'changed' : rowType

  const handleClick = (e: React.MouseEvent) => {
    if ((e.ctrlKey || e.metaKey) && lineNum != null) {
      onLineClick?.(lineNum)
    }
  }

  return (
    <div
      data-row-index={index}
      className={`flex items-center min-w-full px-3 whitespace-pre cursor-pointer ${codeBgClass(side, rowType, changed, focused)}`}
      style={{ height: SPLIT_ROW_HEIGHT }}
      onClick={handleClick}
    >
      <WordDiffSegment
        oldText={row.oldContent}
        newText={row.newContent}
        language={language}
        type={segType}
        isRight={isRight}
      />
    </div>
  )
}

/** memo：虚拟化窗口内，聚焦切换时仅相关行重渲染 */
export const SplitGutterCell = memo(SplitGutterCellImpl)
export const SplitCodeCell = memo(SplitCodeCellImpl)
