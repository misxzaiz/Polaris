/**
 * P2 泳道图 · LaneGraph 组件测试
 *
 * 纯渲染验证（spec §三 验收 4）：
 * - commit 行渲染圆点节点
 * - merge 行渲染方块节点 + 贯穿线 + 斜线汇入
 * - 空 cells 渲染空 span
 * - refs 标签由 HistoryTab 渲染（组件本身只画 lane 原语）
 */

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { LaneGraph } from './LaneGraph'
import type { GitLaneRow } from '@/types/git'

function makeRow(cells: GitLaneRow['cells'], refs: GitLaneRow['refs'] = []): GitLaneRow {
  return { sha: 'abc123', cells, refs }
}

describe('LaneGraph (P2 泳道图)', () => {
  it('无 cells → 渲染空 span', () => {
    const { container } = render(<LaneGraph row={makeRow([])} />)
    expect(container.querySelector('span')).toBeInTheDocument()
    expect(container.querySelector('svg')).not.toBeInTheDocument()
  })

  it('单主线 commit → 一个圆点节点', () => {
    const row = makeRow([
      { lane: 0, node: 'commit', edgeDown: null, edgeUp: null },
    ])
    const { container } = render(<LaneGraph row={row} />)
    const circle = container.querySelector('circle')
    expect(circle).toBeInTheDocument()
    // 节点颜色用主题 token（text-primary）
    expect(circle!.getAttribute('class')).toContain('text-primary')
  })

  it('merge 行 → 方块节点 + 贯穿线 + 斜线', () => {
    const row = makeRow([
      { lane: 0, node: 'merge', edgeDown: 0, edgeUp: null },
      { lane: 1, node: 'empty', edgeDown: null, edgeUp: 0 },
    ])
    const { container } = render(<LaneGraph row={row} />)
    const rect = container.querySelector('rect')
    expect(rect).toBeInTheDocument()
    // 贯穿线（empty + edgeDown）
    const lines = container.querySelectorAll('line')
    // merge 行的 empty 无 edgeDown（edgeDown null）→ 只有斜线
    expect(lines.length).toBe(1)
    // 斜线 x 起点在 lane1，终点在 lane0
    const sl = lines[0]
    expect(parseFloat(sl.getAttribute('x1')!)).toBeGreaterThan(parseFloat(sl.getAttribute('x2')!))
  })

  it('多泳道 empty 贯穿线渲染', () => {
    const row = makeRow([
      { lane: 0, node: 'commit', edgeDown: 0, edgeUp: null },
      { lane: 1, node: 'empty', edgeDown: 1, edgeUp: null },
    ])
    const { container } = render(<LaneGraph row={row} />)
    // 1 条贯穿线（lane1 empty）+ 1 圆点
    expect(container.querySelectorAll('line').length).toBe(1)
    expect(container.querySelectorAll('circle').length).toBe(1)
  })
})
