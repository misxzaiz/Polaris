/**
 * cap.ui.render 内置帧渲染器（chatCardRegistry key = 'ui.render'）
 *
 * 职责：
 * 1. 统一解析 cap.ui.render request 的 payload {title, frame}（此前 question/form/
 *    confirm 帧落到 JSON 兜底且无法应答，见 plans/ui-template-runtime-v1.md §1）
 * 2. template 帧：DSL 模板渲染（uiTemplateNodes）+ footer buttons + 值收集
 * 3. question / form / confirm：最小组件渲染（对手写形状容错）
 * 4. custom 帧（chatCardRegistry 未命中回答组件时）：JSON 折叠展示
 *
 * 应答协议（对 plans/ui-template-runtime-v1.md §3.4）：
 * - template → { templateId, action, values }
 * - question → { answers: [{ selected, customInput }] }
 * - form     → { values }
 * - confirm  → { confirmed }
 */

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Info } from 'lucide-react'
import type { PluginChatCardProps } from '@/plugin-system/types'
import type {
  UiFrameField,
  UiFrameQuestion,
  UiTemplateButton,
  UiTemplateNode,
  UiTemplateDef,
} from '@/plugin-system/uiFrameTypes'
import { collectDefaultValues, interpolateParams } from '@/plugin-system/uiFrameTypes'
import { renderTemplateNodes } from './uiTemplateNodes'

// ============================ 小工具 ============================

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function frameType(frame: unknown): string | undefined {
  return isRecord(frame) && typeof frame.type === 'string' ? frame.type : undefined
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function parseQuestions(frame: Record<string, unknown>): UiFrameQuestion[] {
  const raw = Array.isArray(frame.questions) ? frame.questions : []
  // 手写容错：question 字符串也能解析（AI 传 ["a","b"] 简易形状）
  return raw
    .map((q): UiFrameQuestion | null => {
      if (typeof q === 'string') return { question: q }
      if (!isRecord(q) || typeof q.question !== 'string') return null
      const options = Array.isArray(q.options)
        ? q.options.map((o) => (isRecord(o) ? o : { value: String(o) }))
        : undefined
      return {
        question: q.question,
        header: typeof q.header === 'string' ? q.header : undefined,
        options,
        multiSelect: q.multiSelect === true,
      }
    })
    .filter((q): q is UiFrameQuestion => q !== null)
}

function parseFields(frame: Record<string, unknown>): UiFrameField[] {
  const raw = Array.isArray(frame.fields) ? frame.fields : []
  return raw
    .map((f): UiFrameField | null => {
      if (!isRecord(f) || typeof f.name !== 'string') return null
      return {
        name: f.name,
        type:
          f.type === 'number' || f.type === 'boolean' || f.type === 'select' || f.type === 'textarea'
            ? f.type
            : 'string',
        label: typeof f.label === 'string' ? f.label : undefined,
        placeholder: typeof f.placeholder === 'string' ? f.placeholder : undefined,
        options: Array.isArray(f.options) ? f.options.map(String) : undefined,
        required: f.required === true,
        default:
          typeof f.default === 'string' || typeof f.default === 'number' || typeof f.default === 'boolean'
            ? f.default
            : undefined,
        help: typeof f.help === 'string' ? f.help : undefined,
      }
    })
    .filter((f): f is UiFrameField => f !== null)
}

function parseTemplateDef(frame: Record<string, unknown>): UiTemplateDef | undefined {
  const t = frame.template
  if (!isRecord(t)) return undefined
  const dsl = Array.isArray(t.dsl) ? (t.dsl as UiTemplateNode[]) : undefined
  if (!dsl?.length) return undefined
  const buttons = Array.isArray(t.buttons)
    ? (t.buttons as UiTemplateButton[]).filter(
        (b) => isRecord(b) && typeof b.id === 'string' && typeof b.label === 'string',
      )
    : undefined
  return {
    templateId: asString(t.templateId),
    title: asString(t.title),
    description: isRecord(t) && typeof t.description === 'string' ? t.description : undefined,
    dsl,
    buttons: buttons?.length ? buttons : undefined,
  }
}

// ============================ 帧视图分片 ============================

interface FrameViewProps {
  frame: Record<string, unknown>
  disabled: boolean
  isDisplay: boolean
  busy: boolean
  /** footer 按钮 + 收集应答的统一出口；display 模式下禁用 */
  onAnswer: (answer: Record<string, unknown>, actionLabel?: string) => void
}

/** template 帧：DSL + buttons */
function TemplateFrameView({ frame, disabled, isDisplay, busy, onAnswer }: FrameViewProps) {
  const def = parseTemplateDef(frame)
  const defaults = useMemo(
    () => (def ? collectDefaultValues(def.dsl) : {}),
    [def],
  )
  const [values, setValues] = useState<Record<string, string>>(() => defaults)
  // 模板注册是运行时态：块重放时 default 可能变化，跟随补齐缺失字段
  useEffect(() => {
    setValues((v) => ({ ...defaults, ...v }))
  }, [defaults])

  if (!def) {
    return (
      <div className="rounded-md border border-border bg-background-surface px-3 py-2 text-xs text-text-secondary">
        模板帧缺少 template 定义（未注册或 payload 不完整）
      </div>
    )
  }

  const ctx = {
    params: isRecord(frame.params) ? frame.params : undefined,
    disabled,
    values,
    onValue: (field: string, value: string) =>
      setValues((v) => ({ ...v, [field]: value })),
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {def.description && (
        <span className="text-xs text-text-secondary">
          {interpolateParams(def.description, ctx.params)}
        </span>
      )}
      {renderTemplateNodes(def.dsl, ctx)}
      {def.buttons && def.buttons.length > 0 && (
        <div className="flex items-center justify-end gap-2 border-t border-border pt-2">
          {isDisplay && (
            <span className="mr-auto inline-flex items-center gap-1 text-[11px] text-text-muted">
              <Info className="h-3 w-3" />
              展示模式（不等待应答）
            </span>
          )}
          {def.buttons.map((btn) => (
            <button
              key={btn.id}
              type="button"
              disabled={disabled || busy}
              onClick={() =>
                onAnswer(
                  {
                    templateId: frame.templateId ?? def.templateId,
                    action: btn.id,
                    values: { ...defaults, ...values },
                  },
                  btn.label,
                )
              }
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                btn.danger
                  ? 'bg-danger/10 text-danger hover:bg-danger/20'
                  : 'bg-primary/10 text-primary hover:bg-primary/20'
              }`}
            >
              {interpolateParams(btn.label, ctx.params)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** question 帧：多题 + 选项 + 自定义输入 */
function QuestionFrameView({ frame, disabled, busy, onAnswer }: FrameViewProps) {
  const questions = parseQuestions(frame)
  const [answers, setAnswers] = useState<Array<{ selected: string[]; customInput: string }>>(
    () => questions.map(() => ({ selected: [], customInput: '' })),
  )

  if (!questions.length) {
    return (
      <div className="rounded-md border border-border bg-background-surface px-3 py-2 text-xs text-text-secondary">
        question 帧缺少可解析的 questions
      </div>
    )
  }
  if (disabled || busy) {
    // 只读回显
    return (
      <div className="flex flex-col gap-2">
        {questions.map((q, i) => (
          <div key={i} className="text-xs text-text-secondary">
            <span className="text-text-primary">{q.question}</span>
            {answers[i]?.selected.length ? (
              <span>&nbsp;&nbsp;→&nbsp;{answers[i].selected.join('、')}</span>
            ) : null}
          </div>
        ))}
      </div>
    )
  }

  const setAnswer = (i: number, patch: Partial<{ selected: string[]; customInput: string }>) =>
    setAnswers((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)))

  return (
    <div className="flex flex-col gap-3">
      {questions.map((q, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-primary">{q.question}</span>
          {q.options?.map((opt) => {
            const value = opt.value ?? opt.label ?? ''
            const selected = answers[i]?.selected.includes(value) ?? false
            return (
              <button
                key={value}
                type="button"
                disabled={busy}
                onClick={() =>
                  setAnswer(i, {
                    selected: q.multiSelect
                      ? selected
                        ? answers[i].selected.filter((v) => v !== value)
                        : [...answers[i].selected, value]
                      : [value],
                  })
                }
                className={`flex flex-col rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
                  selected
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background-surface text-text-secondary hover:bg-background-hover'
                }`}
              >
                <span className="font-medium">{opt.label ?? opt.value}</span>
                {opt.description && (
                  <span className="text-[11px] text-text-muted">{opt.description}</span>
                )}
              </button>
            )
          })}
          <input
            value={answers[i]?.customInput ?? ''}
            disabled={busy}
            placeholder="自定义输入（可选）"
            onChange={(e) => setAnswer(i, { customInput: e.target.value })}
            className="h-7 rounded-md border border-border bg-background-surface px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      ))}
      <div className="flex justify-end border-t border-border pt-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onAnswer({ answers: answers.map((a) => ({ ...a })) }, '提交')
          }
          className="rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
        >
          提交
        </button>
      </div>
    </div>
  )
}

/** form 帧：schema 字段（string/number/boolean/select/textarea） */
function FormFrameView({ frame, disabled, busy, onAnswer }: FrameViewProps) {
  const fields = parseFields(frame)
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {}
    for (const f of fields) if (f.default !== undefined) init[f.name] = f.default
    return init
  })

  if (!fields.length) {
    return (
      <div className="rounded-md border border-border bg-background-surface px-3 py-2 text-xs text-text-secondary">
        form 帧缺少可解析的 fields
      </div>
    )
  }

  const submit = () => onAnswer({ values }, '提交')

  return (
    <div className="flex flex-col gap-2.5">
      {(disabled || busy) ? (
        <div className="flex flex-col gap-1">
          {fields.map((f) => (
            <div key={f.name} className="text-xs text-text-secondary">
              <span className="text-text-muted">{f.label ?? f.name}: </span>
              {String(values[f.name] ?? '')}
            </div>
          ))}
        </div>
      ) : (
        fields.map((f) => (
          <label key={f.name} className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">
              {f.label ?? f.name}
              {f.required && <span className="text-danger"> *</span>}
            </span>
            {f.type === 'boolean' ? (
              <input
                type="checkbox"
                checked={values[f.name] === true}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.checked }))}
                className="h-3.5 w-3.5 accent-primary"
              />
            ) : f.type === 'select' ? (
              <select
                value={String(values[f.name] ?? '')}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                className="h-7 rounded-md border border-border bg-background-surface px-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="">{f.placeholder ?? '— 选择 —'}</option>
                {(f.options ?? []).map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : f.type === 'textarea' ? (
              <textarea
                value={String(values[f.name] ?? '')}
                placeholder={f.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                className="min-h-12 w-full resize-y rounded-md border border-border bg-background-surface px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (
              <input
                type={f.type === 'number' ? 'number' : 'text'}
                value={String(values[f.name] ?? '')}
                placeholder={f.placeholder}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    [f.name]: f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value,
                  }))
                }
                className="h-7 rounded-md border border-border bg-background-surface px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            )}
            {f.help && <span className="text-[11px] text-text-tertiary">{f.help}</span>}
          </label>
        ))
      )}
      {!disabled && !busy && (
        <div className="flex justify-end border-t border-border pt-2">
          <button
            type="button"
            onClick={submit}
            className="rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
          >
            提交
          </button>
        </div>
      )}
    </div>
  )
}

/** confirm 帧：内容 + 默认按钮组 */
function ConfirmFrameView({ frame, disabled, busy, onAnswer }: FrameViewProps) {
  const content = asString(frame.content)
  const yes = asString(frame.yesLabel) || '确认'
  const no = asString(frame.noLabel) || '取消'
  const danger = frame.danger === true
  if (disabled || busy) {
    return <span className="text-xs text-text-secondary">{content}</span>
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-text-secondary">{content}</span>
      <div className="flex justify-end gap-2 border-t border-border pt-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onAnswer({ confirmed: false }, no)}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-background-hover"
        >
          {no}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onAnswer({ confirmed: true }, yes)}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            danger
              ? 'bg-danger/10 text-danger hover:bg-danger/20'
              : 'bg-primary/10 text-primary hover:bg-primary/20'
          }`}
        >
          {yes}
        </button>
      </div>
    </div>
  )
}

/** custom 帧（注册表未命中的自定义数据）：支持 HTML 图表渲染 */
function CustomFrameView({ frame }: { frame: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false)
  const [htmlSrc, setHtmlSrc] = useState<string | null>(null)

  // 检测是否为 HTML 图表数据
  const isHtmlChart = (
    typeof frame.html === 'string' &&
    (frame.html.includes('<canvas') || frame.html.includes('<svg') || frame.html.includes('<script'))
  ) || false

  // 处理 HTML 渲染（仅允许内联 data URI，安全）
  useEffect(() => {
    if (typeof frame.html === 'string' && isHtmlChart) {
      // 将 HTML 转换为 blob URL（沙箱隔离）
      const blob = new Blob([frame.html], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      setHtmlSrc(url)
      return () => URL.revokeObjectURL(url)
    }
  }, [frame.html, isHtmlChart])

  if (isHtmlChart && htmlSrc) {
    return (
      <div className="flex flex-col gap-2">
        <div className="rounded-md border border-border bg-background-surface">
          <iframe
            src={htmlSrc}
            className="w-full min-h-[300px]"
            sandbox="allow-scripts"
            title="Chart Preview"
          />
        </div>
        <div className="flex items-center gap-2 text-[11px] text-text-muted">
          <span>📊 HTML 图表渲染</span>
          <button
            onClick={() => window.open(htmlSrc, '_blank')}
            className="rounded px-2 py-0.5 bg-primary/10 text-primary hover:bg-primary/20"
          >
            新窗口查看
          </button>
        </div>
      </div>
    )
  }

  const dataText = JSON.stringify(frame, null, 2)
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 self-start text-[11px] text-text-muted hover:text-text-secondary"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        自定义帧数据
      </button>
      {expanded && (
        <pre className="max-h-48 overflow-auto rounded-md border border-border bg-background-surface px-2 py-1.5 font-mono text-[11px] leading-relaxed text-text-secondary">
          {dataText}
        </pre>
      )}
    </div>
  )
}

// ============================ 主卡片 ============================

const STATUS_LABEL: Record<string, string> = {
  answered: '已应答',
  declined: '已跳过',
  timeout: '已超时',
  failed: '渲染失败',
}

/** preview 字段（response 回显的紧凑形式） */
function responsePreview(response: unknown): string {
  if (response === undefined || response === null) return ''
  if (typeof response === 'string') return response
  if (isRecord(response) && typeof response.action === 'string') return response.action
  try {
    return JSON.stringify(response).slice(0, 80)
  } catch {
    return ''
  }
}

export function UiFrameCard(props: PluginChatCardProps) {
  const { data, status, respond, response, mode } = props
  const [busy, setBusy] = useState(false)

  const payload = isRecord(data) ? data : undefined
  const frame = isRecord(payload?.frame) ? (payload?.frame as Record<string, unknown>) : undefined
  const title = asString(payload?.title).trim()

  if (!frame) {
    return (
      <section className="my-2 w-full rounded-lg border border-border bg-background-elevated px-3 py-2 text-xs text-text-secondary">
        可交互帧数据缺失（payload.frame 不存在）
      </section>
    )
  }

  const isDisplay = frameType(frame) === 'template' && frame.mode === 'display'
  // 待应答：interaction 且 pending 且有 respond 通道
  const interactive = mode === 'interaction' && status === 'pending' && typeof respond === 'function'
  const answered = mode === 'interaction' && (status === 'answered' || status === 'declined')

  const handleAnswer = async (answer: Record<string, unknown>, actionLabel?: string) => {
    if (!respond || busy) return
    setBusy(true)
    try {
      await respond(answer) // 提交后 eventHandler 经 plugin_card_answered 推进 status
    } catch (e) {
      setBusy(false)
      console.error('[UiFrameCard] 提交应答失败', e, actionLabel)
    }
  }

  const disabled = !interactive || busy
  const viewProps: FrameViewProps = {
    frame,
    disabled,
    isDisplay,
    busy,
    onAnswer: (answer, label) => {
      void handleAnswer(answer, label)
    },
  }

  return (
    <section className="my-2 w-full overflow-hidden rounded-lg border border-border bg-background-elevated">
      {(title || frameType(frame)) && (
        <header className="flex min-w-0 items-center gap-2 border-b border-border bg-background-surface px-3 py-2">
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
            {title || '交互请求'}
          </div>
          <span className="shrink-0 rounded bg-background-hover px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
            {frameType(frame)}
          </span>
        </header>
      )}
      <div className="px-3 py-2.5">
        {frameType(frame) === 'template' && <TemplateFrameView {...viewProps} />}
        {frameType(frame) === 'question' && <QuestionFrameView {...viewProps} />}
        {frameType(frame) === 'form' && <FormFrameView {...viewProps} />}
        {frameType(frame) === 'confirm' && <ConfirmFrameView {...viewProps} />}
        {frameType(frame) === 'custom' && <CustomFrameView frame={frame} />}
        {frameType(frame) !== undefined && !['template', 'question', 'form', 'confirm', 'custom'].includes(frameType(frame) ?? '') && (
          <span className="text-[11px] text-text-muted">未知帧类型</span>
        )}
      </div>
      {(isDisplay || answered) && (
        <footer className="border-t border-border bg-background-surface px-3 py-1.5">
          <span className="inline-flex items-center gap-1 text-[11px] text-text-muted">
            <Info className="h-3 w-3" />
            {isDisplay
              ? '展示模式（不等待应答）'
              : `${STATUS_LABEL[status] ?? status}${response ? ` · ${responsePreview(response)}` : ''}`}
          </span>
        </footer>
      )}
    </section>
  )
}
