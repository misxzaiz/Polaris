/**
 * UI 模板 DSL 渲染器（cap.ui.render template 帧）
 *
 * 节点白名单见 src/plugin-system/uiFrameTypes.ts（与 Rust validate_template_* 同步）。
 * 纪律：全部走主题 token（border-border / text-text-* / bg-* 等），无硬编码颜色字号。
 * 渲染容错：未知节点/非法结构画占位错误，不抛错不崩（后端注册时已 fail fast）。
 */

import type { ReactNode } from 'react'
import type { UiGap, UiTemplateNode, UiTone } from '@/plugin-system/uiFrameTypes'
import { interpolateParams } from '@/plugin-system/uiFrameTypes'
import { ChartNodeView } from './chartNodeView'

/** 渲染上下文：插值参数 + 交互闭包依赖 */
export interface UiNodeRenderContext {
  /** {{param}} 插值来源 */
  params?: Record<string, unknown>
  /** display 模式 / 已应答后控件只读 */
  disabled: boolean
  /** input/select 当前值（含未填字段，answer 时用默认值兜底） */
  values: Record<string, string>
  /** 用户修改控件值 */
  onValue: (field: string, value: string) => void
}

const GAP_CLASS: Record<UiGap, string> = {
  none: 'gap-0',
  xs: 'gap-1',
  sm: 'gap-2',
  md: 'gap-3',
  lg: 'gap-5',
}

const TEXT_TONE_CLASS: Record<UiTone, string> = {
  primary: 'text-text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-text-secondary',
}

const BADGE_CLASS: Record<UiTone, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
  neutral: 'bg-background-hover text-text-secondary',
}

const ALIGN_CLASS = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
} as const

function text(content: unknown, ctx: UiNodeRenderContext, fallback = ''): string {
  return interpolateParams(typeof content === 'string' ? content : fallback, ctx.params)
}

function renderNode(node: UiTemplateNode, ctx: UiNodeRenderContext): ReactNode {
  switch (node.type) {
    case 'vstack':
      return (
        <div className={`flex flex-col ${GAP_CLASS[node.gap ?? 'md']}`}>
          {node.children.map((child, i) => (
            <div key={i}>{renderNode(child, ctx)}</div>
          ))}
        </div>
      )
    case 'hstack':
      return (
        <div
          className={`flex flex-row ${GAP_CLASS[node.gap ?? 'md']} ${
            ALIGN_CLASS[node.align ?? 'center']
          }`}
        >
          {node.children.map((child, i) => (
            <div key={i}>{renderNode(child, ctx)}</div>
          ))}
        </div>
      )
    case 'text': {
      const content = text(node.content, ctx)
      return (
        <span
          className={
            `${node.bold ? 'font-semibold ' : ''}` +
            (node.tone ? TEXT_TONE_CLASS[node.tone] : 'text-text-primary')
          }
        >
          {content}
        </span>
      )
    }
    case 'metric':
      return (
        <div className="min-w-24 rounded-md border border-border bg-background-surface px-3 py-2">
          {node.label && (
            <div className="text-[11px] text-text-muted">
              {text(node.label, ctx)}
            </div>
          )}
          <div className="text-lg font-semibold text-text-primary">
            {text(node.value, ctx)}
          </div>
          {node.hint && (
            <div className="mt-0.5 text-[11px] text-text-tertiary">
              {text(node.hint, ctx)}
            </div>
          )}
        </div>
      )
    case 'badge': {
      const tone: UiTone = node.tone ?? 'neutral'
      return (
        <span
          className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${BADGE_CLASS[tone]}`}
        >
          {text(node.label, ctx)}
        </span>
      )
    }
    case 'table': {
      const head = node.columns.map((col, i) => text(col, ctx, `#${i}`))
      return (
        <div className="max-h-56 overflow-auto rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="bg-background-surface text-text-muted">
                {head.map((h, i) => (
                  <th key={i} className="border-b border-border px-2 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, r) => (
                <tr key={r} className="odd:bg-transparent even:bg-background-surface/50">
                  {row.map((cell, c) => (
                    <td key={c} className="border-b border-border/60 px-2 py-1.5 text-text-secondary">
                      {text(cell, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'progress': {
      const pct = Math.min(100, Math.max(0, node.value))
      return (
        <div className="w-full">
          <div className="flex items-center justify-between">
            {node.label && (
              <span className="text-[11px] text-text-muted">{text(node.label, ctx)}</span>
            )}
            <span className="font-mono text-[11px] text-text-secondary">{pct}%</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-background-surface">
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )
    }
    case 'divider': {
      const label = node.label ? text(node.label, ctx) : ''
      if (!label) return <div className="h-px w-full border-t border-border" />
      return (
        <div className="flex w-full items-center gap-2">
          <div className="h-px flex-1 border-t border-border" />
          <span className="text-[11px] text-text-muted">{label}</span>
          <div className="h-px flex-1 border-t border-border" />
        </div>
      )
    }
    case 'input': {
      const value = ctx.values[node.field] ?? ''
      return (
        <label className="flex w-full flex-col gap-1">
          {node.label && (
            <span className="text-[11px] text-text-muted">{text(node.label, ctx)}</span>
          )}
          {node.multiline ? (
            <textarea
              value={value}
              disabled={ctx.disabled}
              placeholder={text(node.placeholder ?? '', ctx) || undefined}
              onChange={(e) => ctx.onValue(node.field, e.target.value)}
              className="min-h-12 w-full resize-y rounded-md border border-border bg-background-surface px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
            />
          ) : (
            <input
              value={value}
              disabled={ctx.disabled}
              placeholder={text(node.placeholder ?? '', ctx) || undefined}
              onChange={(e) => ctx.onValue(node.field, e.target.value)}
              className="h-7 w-full rounded-md border border-border bg-background-surface px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
            />
          )}
        </label>
      )
    }
    case 'select': {
      const value = ctx.values[node.field] ?? ''
      return (
        <label className="flex w-full flex-col gap-1">
          {node.label && (
            <span className="text-[11px] text-text-muted">{text(node.label, ctx)}</span>
          )}
          <select
            value={value}
            disabled={ctx.disabled}
            onChange={(e) => ctx.onValue(node.field, e.target.value)}
            className={`h-7 w-full rounded-md border border-border bg-background-surface px-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60 ${
              value === '' ? 'text-text-tertiary' : ''
            }`}
          >
            <option value="">{text(node.placeholder ?? '', ctx) || '— 选择 —'}</option>
            {node.options.map((opt) => (
              <option key={opt} value={text(opt, ctx)}>
                {text(opt, ctx)}
              </option>
            ))}
          </select>
        </label>
      )
    }
    case 'chart':
      return <ChartNodeView node={node} />
    default:
      return (
        <span className="rounded bg-error-faint/40 px-2 py-1 text-[11px] text-danger">
          未知模板节点
        </span>
      )
  }
}

/** DSL 渲染入口：安全包裹（限深由后端保证，仍做防御裁剪） */
export function renderTemplateNodes(
  nodes: UiTemplateNode[],
  ctx: UiNodeRenderContext,
  maxNodes = 64,
): ReactNode {
  const trimmed = nodes.slice(0, maxNodes)
  return (
    <div className="flex flex-col gap-3">
      {trimmed.map((node, i) => (
        <div key={i}>{renderNode(node, ctx)}</div>
      ))}
      {nodes.length > maxNodes && (
        <span className="text-[11px] text-text-muted">…超出节点上限，已截断</span>
      )}
    </div>
  )
}
