/**
 * Split（并排）双栏视图（窗口化虚拟渲染）
 *
 * 布局：单一 CSS Grid 统一表头与代码区的列 —— 左列(1) / 分隔条(2，跨行) / 右列(3)，
 * 由同一 ratio 驱动，保证「旧/新版本」表头分界与代码区分隔条像素级对齐。
 *
 * 每一侧再拆为「固定行号列(仅纵向滚动) + 代码列(横向+纵向)」：
 * - 行号列不参与横向滚动，天然固定，代码也不会盖到其上；
 * - 左右两个代码列横向 + 纵向联动；行号列纵向跟随。
 *
 * 虚拟化：固定行高（SPLIT_ROW_HEIGHT），按滚动位置只渲染「上 spacer + 可视窗口行 + 下 spacer」，
 * 既保留行号固定列与各列独立横向滚动（min-w-max 由窗口内最宽行撑开），又把渲染行数从 N 降到一屏。
 * 分隔条可拖拽调宽并持久化。
 */

import { useRef, useState, useLayoutEffect, useEffect } from 'react'
import type { SplitDiffRow } from './splitRows'
import { SplitGutterCell, SplitCodeCell, SPLIT_ROW_HEIGHT } from './SplitSideRow'
import { useSplitRatio } from './useSplitRatio'
import { useSplitScrollSync } from './useSplitScrollSync'
import { GUTTER_WIDTH } from './types'

const DIVIDER_WIDTH = 8
/** 窗口上下额外渲染的行数，缓冲快速滚动时的空白 */
const OVERSCAN = 12

interface SplitDiffViewProps {
  rows: SplitDiffRow[]
  language?: string
  focusedRowIndex?: number
  onLineClick?: (lineNumber: number) => void
  t: (key: string) => string
}

export function SplitDiffView({ rows, language, focusedRowIndex, onLineClick, t }: SplitDiffViewProps) {
  const gridRef = useRef<HTMLDivElement>(null)
  const { ratio, dividerHandlers } = useSplitRatio(gridRef)

  // 4 个滚动元素：左右代码列(横+纵) + 左右行号列(纵向跟随)
  const [leftCode, setLeftCode] = useState<HTMLDivElement | null>(null)
  const [rightCode, setRightCode] = useState<HTMLDivElement | null>(null)
  const [leftGutter, setLeftGutter] = useState<HTMLDivElement | null>(null)
  const [rightGutter, setRightGutter] = useState<HTMLDivElement | null>(null)

  useSplitScrollSync(leftCode, rightCode, leftGutter, rightGutter)

  // 虚拟化窗口状态：滚动偏移 + 视口高度（由左代码列驱动；右列滚动经 scroll-sync 镜像到左列后同样触发）
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)

  useLayoutEffect(() => {
    if (!leftCode) return
    const measure = () => setViewportH(leftCode.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(leftCode)
    return () => ro.disconnect()
  }, [leftCode])

  useEffect(() => {
    if (!leftCode) return
    const onScroll = () => setScrollTop(leftCode.scrollTop)
    leftCode.addEventListener('scroll', onScroll, { passive: true })
    return () => leftCode.removeEventListener('scroll', onScroll)
  }, [leftCode])

  // 聚焦变更：将目标行滚到视口中央（设置 scrollTop 即触发 scroll-sync 联动 + 窗口重算）
  useEffect(() => {
    if (focusedRowIndex == null || !leftCode) return
    const target = focusedRowIndex * SPLIT_ROW_HEIGHT - leftCode.clientHeight / 2 + SPLIT_ROW_HEIGHT / 2
    leftCode.scrollTop = Math.max(0, target)
  }, [focusedRowIndex, leftCode])

  const total = rows.length
  const start = Math.max(0, Math.floor(scrollTop / SPLIT_ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / SPLIT_ROW_HEIGHT) + OVERSCAN)
  const topPad = start * SPLIT_ROW_HEIGHT
  const bottomPad = Math.max(0, (total - end) * SPLIT_ROW_HEIGHT)
  const windowRows: number[] = []
  for (let i = start; i < end; i++) windowRows.push(i)

  const renderSide = (
    side: 'left' | 'right',
    setGutter: (el: HTMLDivElement | null) => void,
    setCode: (el: HTMLDivElement | null) => void,
    gridClass: string,
  ) => (
    <div className={`flex h-full overflow-hidden ${gridClass}`}>
      {/* 固定行号列：仅纵向，不参与横向滚动 */}
      <div
        ref={setGutter}
        className="shrink-0 overflow-hidden border-r border-border-subtle"
        style={{ width: GUTTER_WIDTH }}
      >
        <div style={{ paddingTop: topPad, paddingBottom: bottomPad }}>
          {windowRows.map((i) => (
            <SplitGutterCell key={i} row={rows[i]} side={side} focused={focusedRowIndex === i} />
          ))}
        </div>
      </div>
      {/* 代码列：横向 + 纵向滚动 */}
      <div ref={setCode} className="flex-1 overflow-auto">
        <div className="min-w-max" style={{ paddingTop: topPad, paddingBottom: bottomPad }}>
          {windowRows.map((i) => (
            <SplitCodeCell
              key={i}
              row={rows[i]}
              side={side}
              index={i}
              focused={focusedRowIndex === i}
              language={language}
              onLineClick={onLineClick}
            />
          ))}
        </div>
      </div>
    </div>
  )

  return (
    <div
      ref={gridRef}
      className="grid h-full font-mono text-sm select-text"
      style={{
        gridTemplateColumns: `calc(${ratio} * 100% - ${DIVIDER_WIDTH / 2}px) ${DIVIDER_WIDTH}px minmax(0, 1fr)`,
        gridTemplateRows: 'auto minmax(0, 1fr)',
      }}
    >
      {/* 表头（与代码区共用第 1/3 列） */}
      <div className="row-start-1 col-start-1 flex bg-background-elevated border-b border-border text-xs text-text-tertiary overflow-hidden">
        <div style={{ width: GUTTER_WIDTH }} className="shrink-0 px-2 py-1 text-right select-none border-r border-border-subtle">#</div>
        <div className="flex-1 px-3 py-1 font-sans min-w-0 truncate">{t('diff.oldVersion')}</div>
      </div>
      <div className="row-start-1 col-start-3 flex bg-background-elevated border-b border-border text-xs text-text-tertiary overflow-hidden">
        <div style={{ width: GUTTER_WIDTH }} className="shrink-0 px-2 py-1 text-right select-none border-r border-border-subtle">#</div>
        <div className="flex-1 px-3 py-1 font-sans min-w-0 truncate">{t('diff.newVersion')}</div>
      </div>

      {/* 分隔条：第 2 列，跨表头 + 代码两行 */}
      <div
        className="row-start-1 row-span-2 col-start-2 relative cursor-col-resize group z-10 touch-none"
        title={t('diff.dragToResize')}
        {...dividerHandlers}
      >
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border group-hover:bg-primary group-hover:w-0.5 transition-all" />
      </div>

      {/* 左右两侧（各含行号列 + 代码列） */}
      {renderSide('left', setLeftGutter, setLeftCode, 'row-start-2 col-start-1')}
      {renderSide('right', setRightGutter, setRightCode, 'row-start-2 col-start-3')}
    </div>
  )
}
