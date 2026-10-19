/**
 * 插槽式 UI 改造渲染器（cap.self.mutate 的前端消费端）
 *
 * 在具名挂载点渲染 AI 注入的组件。安全性设计：
 * - slotId 必须命中 SLOT_IDS（合法挂载点），否则不渲染
 * - 只渲染白名单 kind（status-badge / tooltip-label / quick-action），
 *   未知 kind 安全降级为 null —— 杜绝任意 HTML/脚本注入
 *
 * 组件内容：kind → 映射为受控 React element，props 来自 store（字段白名单后端已校验）。
 * 遵循主题 token，不硬编码颜色。
 */
import { useUiSlotStore, selectSlotFill, type SlotId, type SlotFill } from '@/stores/uiSlotStore'

/** 渲染单个插槽填充（未知 kind → null，安全降级） */
export function SlotFillView({ fill, slotId }: { fill: SlotFill; slotId: string }) {
  const props = fill.props ?? {}
  switch (fill.kind) {
    case 'status-badge': {
      const tone = typeof props.tone === 'string' ? props.tone : 'info'
      const toneClass = {
        info: 'bg-primary/10 text-primary',
        warn: 'bg-warning/10 text-warning',
        success: 'bg-success/10 text-success',
        danger: 'bg-danger/10 text-danger',
      }[tone] ?? 'bg-background-elevated text-text-secondary'
      const text = typeof props.text === 'string' ? props.text : '·'
      return (
        <span
          className={`inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] leading-none ${toneClass}`}
          data-slot={slotId}
        >
          <span className="size-1 rounded-full bg-current" aria-hidden />
          {text}
        </span>
      )
    }
    case 'tooltip-label': {
      const label = typeof props.label === 'string' ? props.label : ''
      if (!label) return null
      return (
        <span
          className="shrink-0 text-[11px] text-text-muted"
          data-slot={slotId}
          title={typeof props.target === 'string' ? props.target : undefined}
        >
          {label}
        </span>
      )
    }
    case 'quick-action': {
      const label = typeof props.label === 'string' ? props.label : ''
      if (!label) return null
      return (
        <button
          data-slot={slotId}
          className="shrink-0 px-2 py-0.5 rounded-md border border-border bg-background-elevated text-text-primary text-xs hover:bg-background-hover transition-colors"
        >
          {label}
        </button>
      )
    }
    default:
      // 未知 kind：不渲染（安全降级，防止任意内容注入）
      return null
  }
}

/** 具名插槽挂载点：渲染 slotId 的当前填充（无填充/未知 → null） */
export function UiSlot({ slotId }: { slotId: SlotId }) {
  const slots = useUiSlotStore((s) => s.slots)
  const fill = selectSlotFill(slots, slotId)
  if (!fill) return null
  return <SlotFillView fill={fill} slotId={slotId} />
}