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
 * P2 增量：语义着色。`semantic` prop 由后端预计算（GitLogPage.semantic 每行一个），
 * 节点 + 泳道线按语义色取主题 token；缺省（旧后端/未计算）回退 currentColor。
 *
 * 与 history tab 主题 token 配合（不硬编码色值）。
 */

import type { GitLaneRow } from '@/types/git'
import type { GitLaneSemantic, GitLaneSemanticKind } from '@/types/git'

const LANE_W = 14 // 每泳道宽 px
const NODE_R = 4 // 节点半径（18px 行高下保证可辨识）

interface LaneGraphProps {
  row: GitLaneRow
  height?: number
  /** P2 增量：本行语义色（后端预计算）；缺省回退旧行为 */
  semantic?: GitLaneSemantic | null
}

/** 语义色 → 主题 token class（success/danger/info 语义 token，禁止硬编码色值）
 *  dim 走低透明度（整行淡化）
 */
const SEMANTIC_COLOR: Record<GitLaneSemanticKind, string> = {
  local: 'text-success', // 绿：当前分支内、已同步远程
  unpushed: 'text-danger', // 红：未 push
  merged: 'text-text-secondary', // 灰蓝：已进主干
  dim: 'text-text-tertiary', // 灰暗：历史/孤立
}

export function LaneGraph({ row, height = 18, semantic }: LaneGraphProps) {
  if (!row.cells || row.cells.length === 0) {
    return <span className="w-0" aria-hidden />
  }

  const width = row.cells.length * LANE_W
  const kind = semantic?.kind
  // dim 行整体淡化（泳道线 + 节点都 opacity 降低）；其余语义色不额外降透明度
  const dimmed = kind === 'dim'
  const lineColorClass = kind ? SEMANTIC_COLOR[kind] : 'text-text-tertiary/60'

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`shrink-0 ${dimmed ? 'opacity-45' : 'opacity-90'}`}
      aria-hidden
    >
      {/* 竖线层（empty 泳道贯穿 + merge 行的延续线），画在下层，节点盖在上层 */}
      {row.cells.map((cell, i) => {
        if (cell.node !== 'empty' || cell.edgeDown == null) return null
        return (
          <line
            key={`v-${i}`}
            x1={cell.lane * LANE_W + LANE_W / 2}
            y1={0}
            x2={cell.lane * LANE_W + LANE_W / 2}
            y2={height}
            stroke="currentColor"
            strokeWidth={1.5}
            className={lineColorClass}
          />
        )
      })}

      {/* 斜线（merge 汇入：edgeUp → 本行 merge 节点 lane）。
          起点取父泳道底缘，终点取节点圆心 —— 修正旧绘制收口偏出节点的问题 */}
      {row.cells.map((cell, i) => {
        if (cell.node !== 'empty' || cell.edgeUp == null) return null
        const fromX = cell.lane * LANE_W + LANE_W / 2
        const toX = cell.edgeUp * LANE_W + LANE_W / 2
        return (
          <line
            key={`u-${i}`}
            x1={fromX}
            y1={height}
            x2={toX}
            y2={height / 2}
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            className={lineColorClass}
          />
        )
      })}

      {/* 节点层 */}
      {row.cells.map((cell, i) => {
        const cx = cell.lane * LANE_W + LANE_W / 2
        const cy = height / 2
        // 节点颜色：有语义色用语义色；无则回退 commit=primary / merge=text-primary
        const nodeColorClass = kind
          ? SEMANTIC_COLOR[kind]
          : cell.node === 'commit'
            ? 'text-primary'
            : 'text-text-primary'
        if (cell.node === 'commit') {
          return (
            <circle
              key={`c-${i}`}
              cx={cx}
              cy={cy}
              r={NODE_R}
              fill="currentColor"
              className={nodeColorClass}
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
              className={nodeColorClass}
            />
          )
        }
        return null
      })}
    </svg>
  )
}