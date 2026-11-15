/**
 * chart 节点渲染器（cap.ui.render DSL，自绘 SVG，零依赖）
 *
 * 纪律：零硬编码颜色——系列默认色走主题 CSS 变量序列，且只能经 style 注入
 * （SVG presentation attribute 不解析 var()）；调用方显式指定的 color 是
 * 数据语义色，直接使用。hover 提示用原生 <title>。数据规模与合法性由后端
 * validate_template_node fail fast，此处仅对坐标计算做轻防御。
 */

import type { ReactNode } from 'react'
import type { UiChartDataset, UiTemplateNode } from '@/plugin-system/uiFrameTypes'

export type ChartNode = Extract<UiTemplateNode, { type: 'chart' }>

/** 默认系列色序列：主题 token（--c-* 为 RGB 三元组变量，包 rgb() 使用） */
const SERIES_COLORS = [
  'rgb(var(--c-primary))',
  'rgb(var(--c-accent-ai))',
  'rgb(var(--c-status-success))',
  'rgb(var(--c-status-warning))',
  'rgb(var(--c-status-danger))',
  'rgb(var(--c-status-info))',
]

function seriesColor(ds: UiChartDataset, index: number): string {
  return ds.color ?? SERIES_COLORS[index % SERIES_COLORS.length]
}

/** y 轴上限向上取整到 1/2/5×10^k 的规整值（导出供单测） */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1
  const exp = Math.floor(Math.log10(max))
  const base = Math.pow(10, exp)
  for (const m of [1, 2, 5, 10]) {
    if (max <= m * base) return m * base
  }
  return 10 * base
}

const TICK_COUNT = 4

/** x 轴标签抽样步长（>16 个标签时隔位显示，避免重叠） */
function labelStride(count: number): number {
  return Math.max(1, Math.ceil(count / 16))
}

function AxisChart({ node }: { node: ChartNode }): ReactNode {
  const W = 600
  const H = 280
  const PAD = { top: 14, right: 12, bottom: 26, left: 44 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const values = node.datasets.flatMap((ds) => ds.data).filter((v) => Number.isFinite(v))
  const maxV = niceMax(values.length > 0 ? Math.max(...values, 0) : 0)
  const yOf = (v: number): number =>
    PAD.top + plotH * (1 - Math.min(Math.max(v, 0), maxV) / maxV)
  const groupW = plotW / node.labels.length
  const barW = (groupW * 0.6) / node.datasets.length
  const stride = labelStride(node.labels.length)
  const showGrid = node.showGrid !== false

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={node.title ?? 'chart'}>
      {Array.from({ length: TICK_COUNT + 1 }, (_, i) => {
        const v = (maxV / TICK_COUNT) * i
        const y = yOf(v)
        return (
          <g key={i}>
            {showGrid && i > 0 && (
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y}
                y2={y}
                style={{ stroke: 'rgb(var(--c-border))' }}
                strokeWidth={1}
                strokeOpacity={0.5}
              />
            )}
            <text
              x={PAD.left - 6}
              y={y + 3}
              textAnchor="end"
              fontSize={10}
              fill="currentColor"
              className="text-text-muted"
            >
              {String(v)}
            </text>
          </g>
        )
      })}
      <line
        x1={PAD.left}
        x2={W - PAD.right}
        y1={PAD.top + plotH}
        y2={PAD.top + plotH}
        style={{ stroke: 'rgb(var(--c-border))' }}
        strokeWidth={1}
      />
      {node.labels.map((label, i) =>
        i % stride === 0 ? (
          <text
            key={i}
            x={PAD.left + groupW * (i + 0.5)}
            y={H - 8}
            textAnchor="middle"
            fontSize={10}
            fill="currentColor"
            className="text-text-muted"
          >
            {label}
          </text>
        ) : null,
      )}
      {node.datasets.map((ds, d) => {
        const color = seriesColor(ds, d)
        if (node.chartType === 'line') {
          const pts = ds.data
            .map((v, i) => `${PAD.left + groupW * (i + 0.5)},${yOf(Number.isFinite(v) ? v : 0)}`)
            .join(' ')
          return (
            <g key={d}>
              <polyline
                points={pts}
                fill="none"
                style={{ stroke: color }}
                strokeWidth={2}
                strokeLinejoin="round"
              />
              {ds.data.map((v, i) => (
                <circle key={i} cx={PAD.left + groupW * (i + 0.5)} cy={yOf(Number.isFinite(v) ? v : 0)} r={3} style={{ fill: color }}>
                  <title>{`${ds.label} · ${node.labels[i]}: ${v}`}</title>
                </circle>
              ))}
            </g>
          )
        }
        return (
          <g key={d}>
            {ds.data.map((v, i) => {
              const x = PAD.left + groupW * i + groupW * 0.2 + barW * d
              const y = yOf(Number.isFinite(v) ? v : 0)
              return (
                <rect key={i} x={x} y={y} width={barW} height={PAD.top + plotH - y} style={{ fill: color }} fillOpacity={0.85}>
                  <title>{`${ds.label} · ${node.labels[i]}: ${v}`}</title>
                </rect>
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}

function PieChart({ node }: { node: ChartNode }): ReactNode {
  const SIZE = 280
  const cx = SIZE / 2
  const cy = SIZE / 2
  const r = 110
  const series = node.datasets[0] ?? { label: '', data: [] }
  const values = series.data.map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
  const total = values.reduce((a, b) => a + b, 0)
  // pie 按 label 扇区分色（主题色序列），dataset.color 对整饼无意义、忽略
  let angle = -Math.PI / 2
  const slices =
    total > 0
      ? values.map((v, i) => {
          const sweep = (v / total) * Math.PI * 2
          const a0 = angle
          const a1 = angle + sweep
          angle = a1
          return { value: v, a0, a1, pct: (v / total) * 100, label: node.labels[i], color: SERIES_COLORS[i % SERIES_COLORS.length] }
        })
      : []

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="mx-auto h-auto w-full max-w-70" role="img" aria-label={node.title ?? 'chart'}>
      {total <= 0 && <circle cx={cx} cy={cy} r={r} style={{ fill: 'rgb(var(--c-border))' }} fillOpacity={0.3} />}
      {slices.map(
        (s, i) =>
          s.pct >= 99.9 ? (
            <circle key={i} cx={cx} cy={cy} r={r} style={{ fill: s.color }} fillOpacity={0.9}>
              <title>{`${s.label}: ${s.value}（100%）`}</title>
            </circle>
          ) : (
            <path
              key={i}
              d={`M ${cx} ${cy} L ${cx + r * Math.cos(s.a0)} ${cy + r * Math.sin(s.a0)} A ${r} ${r} 0 ${
                s.pct > 50 ? 1 : 0
              } 1 ${cx + r * Math.cos(s.a1)} ${cy + r * Math.sin(s.a1)} Z`}
              style={{ fill: s.color }}
              fillOpacity={0.9}
            >
              <title>{`${s.label}: ${s.value}（${s.pct.toFixed(1)}%）`}</title>
            </path>
          ),
      )}
    </svg>
  )
}

/** chart 节点入口：标题 + 图表主体 + HTML 图例（图例不在 SVG 内绘制，便于换行） */
export function ChartNodeView({ node }: { node: ChartNode }): ReactNode {
  const showLegend = node.showLegend !== false
  const isPie = node.chartType === 'pie'
  const legendItems = isPie
    ? pieLegend(node)
    : node.datasets.map((ds, i) => ({ label: ds.label, color: seriesColor(ds, i) }))

  return (
    <div className="w-full rounded-md border border-border bg-background-surface p-3">
      {node.title && <div className="mb-2 text-xs font-medium text-text-primary">{node.title}</div>}
      {isPie ? <PieChart node={node} /> : <AxisChart node={node} />}
      {showLegend && legendItems.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {legendItems.map((item, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 text-[11px] text-text-secondary">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              {item.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** pie 图例：每扇区一色（按系列色序列取），附百分比 */
function pieLegend(node: ChartNode): Array<{ label: string; color: string }> {
  const series = node.datasets[0]
  if (!series) return []
  const values = series.data.map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
  const total = values.reduce((a, b) => a + b, 0)
  return values.map((v, i) => ({
    label: total > 0 ? `${node.labels[i]} · ${((v / total) * 100).toFixed(0)}%` : node.labels[i],
    color: SERIES_COLORS[i % SERIES_COLORS.length],
  }))
}
