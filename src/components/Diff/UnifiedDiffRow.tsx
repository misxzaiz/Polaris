/**
 * Unified（行内）视图的单行渲染组件
 *
 * 被全量渲染与 Virtuoso 虚拟化两条路径共用。通过 data-row-index 暴露行索引，
 * 供全量渲染路径的聚焦滚动（scrollIntoView）定位。min-w-max 配合外层 overflow-auto 支持横向滚动。
 */

import type { DiffLine } from '@/services/diffService'
import { WordDiffSegment } from './WordDiffSegment'

const isFolded = (content: string) => content.startsWith('⋯') && content.endsWith('⋯')

interface UnifiedDiffRowProps {
  line: DiffLine
  index: number
  /** 是否为当前聚焦的变更块首行 */
  focused: boolean
  language?: string
}

export function UnifiedDiffRow({ line, index, focused, language }: UnifiedDiffRowProps) {
  const folded = isFolded(line.content)

  const rowBg = focused
    ? 'bg-primary/15 ring-1 ring-inset ring-primary/30'
    : folded
      ? 'bg-background-elevated/50 text-text-tertiary italic justify-center'
      : line.type === 'added'
        ? 'bg-green-500/8'
        : line.type === 'removed'
          ? 'bg-red-500/8'
          : ''

  return (
    <div data-row-index={index} className={`flex gap-0 px-0 py-0.5 min-w-max ${rowBg}`}>
      {!folded && (
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
          line.type === 'removed' && !folded ? 'text-text-tertiary line-through' : 'text-text-secondary'
        }`}
      >
        {folded ? (
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
}
