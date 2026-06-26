/**
 * Split（并排）视图的单行渲染组件
 *
 * 渲染左右两侧。修改行对（isChangedRow）走词级高亮：左侧显示删除/修改部分，
 * 右侧显示新增/修改部分。被全量渲染与 Virtuoso 两条路径共用。
 * min-w-max 配合外层 overflow-auto 支持长行横向滚动；min-h 行高避免内容裁切。
 */

import type { SplitDiffRow, SplitSideType } from './splitRows'
import { isChangedRow } from './splitRows'
import { WordDiffSegment } from './WordDiffSegment'
import { GUTTER_WIDTH } from './types'

interface SplitDiffRowViewProps {
  row: SplitDiffRow
  index: number
  /** 是否为当前聚焦的变更块首行 */
  focused: boolean
  language?: string
  /** Ctrl/Cmd + 点击行时回调，传递该侧行号 */
  onLineClick?: (lineNumber: number) => void
}

/** 计算某一侧内容区背景色 */
function sideBgClass(side: 'left' | 'right', rowType: SplitSideType, changed: boolean, focused: boolean): string {
  if (focused) return 'bg-primary/15 ring-1 ring-inset ring-primary/30'
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

export function SplitDiffRowView({ row, index, focused, language, onLineClick }: SplitDiffRowViewProps) {
  const changed = isChangedRow(row)

  const renderSide = (side: 'left' | 'right') => {
    const isRight = side === 'right'
    const lineNum = isRight ? row.newLineNumber : row.oldLineNumber
    const rowType = isRight ? row.newType : row.oldType
    const isGutterChanged = rowType === 'added' || rowType === 'removed'

    if (rowType === 'folded') {
      return (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-3 py-1 text-xs text-text-tertiary italic text-center bg-background-elevated/50 whitespace-pre">
            {isRight ? row.newContent : row.oldContent}
          </div>
        </div>
      )
    }

    // 修改行对走词级（changed），其余沿用各侧行类型
    const segType = changed ? 'changed' : rowType

    const handleClick = (e: React.MouseEvent) => {
      if ((e.ctrlKey || e.metaKey) && lineNum != null) {
        onLineClick?.(lineNum)
      }
    }

    return (
      <div className="flex flex-1 min-w-0">
        <div
          className="flex flex-col shrink-0 select-none border-r border-border-subtle"
          style={{ width: GUTTER_WIDTH }}
        >
          <div
            className={`px-1.5 py-0.5 text-right text-xs text-text-tertiary ${
              isGutterChanged ? (isRight ? 'bg-green-500/5' : 'bg-red-500/5') : ''
            }`}
          >
            {lineNum ?? (rowType === 'empty' ? '' : '×')}
          </div>
        </div>
        <div
          className={`flex-1 px-3 py-0.5 whitespace-pre min-w-max cursor-pointer ${sideBgClass(side, rowType, changed, focused)}`}
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
      </div>
    )
  }

  return (
    <div data-row-index={index} className="flex min-h-[24px]">
      {renderSide('left')}
      <div className="w-px bg-border shrink-0" />
      {renderSide('right')}
    </div>
  )
}
