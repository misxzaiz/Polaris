/**
 * cap.ui.render 帧与 UI 模板 DSL 类型（前端侧）
 *
 * 与 Rust `src-tauri/src/services/router/ui_render_capability.rs` 的
 * TEMPLATE_NODE_TYPES + validate_template_* 双边同步（协议无运行时校验，
 * 保守对齐是最低纪律，见 AGENTS.md §4.1）。
 *
 * 安全边界：DSL 是声明式白名单，没有 HTML/JS 注入面；未知节点类型渲染错误占位。
 */

export type UiTone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral'

export type UiGap = 'none' | 'xs' | 'sm' | 'md' | 'lg'

/** UI 模板 DSL 节点（v1 白名单，与后端校验同步） */
export type UiTemplateNode =
  | { type: 'vstack'; gap?: UiGap; children: UiTemplateNode[] }
  | {
      type: 'hstack'
      gap?: UiGap
      align?: 'start' | 'center' | 'end'
      children: UiTemplateNode[]
    }
  | { type: 'text'; content: string; tone?: UiTone; bold?: boolean }
  | { type: 'metric'; label?: string; value: string; hint?: string }
  | { type: 'badge'; label: string; tone?: UiTone }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'progress'; value: number; label?: string }
  | { type: 'divider'; label?: string }
  | {
      type: 'input'
      /** 参数名（应答收进 values[field]） */
      field: string
      label?: string
      placeholder?: string
      multiline?: boolean
      default?: string
    }
  | {
      type: 'select'
      field: string
      options: string[]
      label?: string
      placeholder?: string
      default?: string
    }
  | {
      type: 'chart'
      /** 图表类型（area 不在 v1 契约内，填充效果由 bar 的 fill-opacity 表达） */
      chartType: 'line' | 'bar' | 'pie'
      /** X 轴标签（pie 下与 data 一一对应） */
      labels: string[]
      datasets: UiChartDataset[]
      title?: string
      /** 图例（默认 true） */
      showLegend?: boolean
      /** 网格线（默认 true，pie 忽略） */
      showGrid?: boolean
    }

/** chart 节点的数据集；color 是数据语义色（可选 #RRGGBB，缺省走主题色序列） */
export interface UiChartDataset {
  label: string
  data: number[]
  color?: string
}

/** 模板按钮（footer；应答 action = id） */
export interface UiTemplateButton {
  id: string
  label: string
  danger?: boolean
}

/** cap.ui.render register 持久化的模板定义 */
export interface UiTemplateDef {
  templateId: string
  title?: string
  description?: string
  dsl: UiTemplateNode[]
  buttons?: UiTemplateButton[] | null
  owner?: string
  createdAtMs?: number
}

/** template 帧（payload.frame） */
export interface UiTemplateFrame {
  type: 'template'
  templateId: string
  /** 后端按请求 mode 归一：display = 不等应答 */
  mode?: 'interaction' | 'display'
  /** 后端注册的定义内联下发（无状态渲染 + 历史重放） */
  template?: UiTemplateDef
  params?: Record<string, unknown>
}

/** question 帧里的问题（对齐 ask 事件形状的子集） */
export interface UiFrameQuestion {
  question: string
  header?: string
  options?: Array<{ value?: string; label?: string; description?: string }>
  multiSelect?: boolean
}

/** form 帧字段（polaris-ask form schema 子集） */
export interface UiFrameField {
  name: string
  type?: 'string' | 'number' | 'boolean' | 'select' | 'textarea'
  label?: string
  placeholder?: string
  options?: string[]
  required?: boolean
  default?: string | number | boolean
  help?: string
}

/** cap.ui.render request payload（plugin_card 事件 → PluginCardBlock.data） */
export interface UiRenderPayload {
  title?: string
  frame?: Record<string, unknown>
}

/** 收集 input/select 默认值（未填时的兜底值，answer 时合并） */
export function collectDefaultValues(nodes: UiTemplateNode[]): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (node: UiTemplateNode): void => {
    if (node.type === 'vstack' || node.type === 'hstack') {
      node.children.forEach(walk)
    } else if ((node.type === 'input' || node.type === 'select') && node.default !== undefined) {
      out[node.field] = String(node.default)
    }
  }
  nodes.forEach(walk)
  return out
}

/**
 * {{param}} / {{param.path}} 插值。
 * 只对 string/number/boolean 插值；对象/数组返回空串（不可信内容不加注入面）。
 */
export function interpolateParams(
  text: string,
  params?: Record<string, unknown>,
): string {
  if (!text || !/{\{/.test(text) || !params) return text
  return text.replace(/\{\{\s*([\w$][\w$.]*)\s*\}\}/g, (_match, path: string) => {
    const value = path
      .split('.')
      .reduce<unknown>(
        (acc, key) =>
          acc && typeof acc === 'object'
            ? (acc as Record<string, unknown>)[key]
            : undefined,
        params,
      )
    if (value === undefined || value === null) return ''
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return String(value)
    }
    return ''
  })
}
