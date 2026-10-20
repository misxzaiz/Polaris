/**
 * P2 泳道图 · LaneGraph 组件
 *
 * 纯展示组件：接收一行的 lane cells（Rust 端计算好），渲染为泳道 SVG。
 * 不负责 layout 计算（lane 分配在 Rust `compute_lanes`），只负责绘制。
 *
 * 绘制约定（每格固定宽 LANE_W）：
 * - commit 节点：实心圆点
 * - merge 节点：实心方块（区别于 commit）
 * - empty：竖向贯穿线（该泳道有向下延续）
 * - none：空白
 * - 斜线：cell.edgeUp 指向 merge 节点 lane（换行汇入）→ 从本格画斜线到目标 lane
 *
 * 与 history tab 主题 token 配合（不硬编码色值）。
 */

import type { GitLaneRow } from '@/types/git'

const LANE_W = 14 // 每泳道宽 px
const NODE_R = 3 // 节点半径

interface LaneGraphProps {
  row: GitLaneRow
  height?: number
}

export function LaneGraph({ row, height = 18 }: LaneGraphProps) {
  if (!row.cells || row.cells.length === 0) {
    return <span className="w-0" aria-hidden />
  }

  const width = row.cells.length * LANE_W

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 opacity-80"
      aria-hidden
    >
      {/* 竖线（empty 泳道贯穿；含 merge 行的延续线）需画在下层，节点盖在上层 */}
      {row.cells.map((cell, i) => {
        if (cell.node === 'empty' && cell.edgeDown != null) {
          return (
            <line
              key={`v-${i}`}
              x1={cell.lane * LANE_W + LANE_W / 2}
              y1={0}
              x2={cell.lane * LANE_W + LANE_W / 2}
              y2={height}
              stroke="currentColor"
              strokeWidth={1.2}
              className="text-text-tertiary/60"
            />
          )
        }
        return null
      })}

      {/* 斜线（merge 汇入：edgeUp → 本行 merge 节点 lane，竖线延续的泳道同时汇入） */}
      {row.cells.map((cell, i) => {
        if (cell.node !== 'empty' || cell.edgeUp == null) return null
        // 本格是 merge 的父泳道：斜线从该 lane 底部向 merge 节点列汇入
        const fromX = cell.lane * LANE_W + LANE_W / 2
        const toX = cell.edgeUp * LANE_W + LANE_W / 2
        return (
          <line
            key={`u-${i}`}
            x1={fromX}
            y1={height * 0.85}
            x2={toX}
            y2={height * 0.35}
            stroke="currentColor"
            strokeWidth={1.2}
            className="text-text-tertiary/60"
          />
        )
      })}

      {/* 节点层 */}
      {row.cells.map((cell, i) => {
        const cx = cell.lane * LANE_W + LANE_W / 2
        const cy = height / 2
        if (cell.node === 'commit') {
          return (
            <circle
              key={`c-${i}`}
              cx={cx}
              cy={cy}
              r={NODE_R}
              fill="currentColor"
              className="text-primary"
            />
          )
        }
        if (cell.node === 'merge') {
          return (
            <rect
              key={`m-${i}`}
              x={cx - NODE_R}
              y={cy - NODE_R}
              width={NODE_R * 2}
              height={NODE_R * 2}
              fill="currentColor"
              className="text-text-primary"
            />
          )
        }
        return null
      })}
    </svg>
  )
}