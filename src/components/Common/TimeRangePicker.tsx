/**
 * TimeRangePicker — 联动日期范围选择器
 *
 * 单一触发器 + 自绘日历弹层，在同一面板内连续点选「开始 → 结束」日期，
 * 替代两个分离的原生 datetime-local 输入框（外观割裂 + 切换麻烦）。
 *
 * 交互：
 * - 点击触发器打开日历；点第 1 天标记为「开始」，悬停实时预览范围，
 *   点第 2 天完成并自动收起。
 * - 若结束点早于开始点，自动重置为新的开始。
 * - 点同一天两次 = 单日。
 * - 面板内上月/下月翻页，支持跨月选择。
 * - 「清空」回到不限（start/end 置空）。
 *
 * 纯 CSS 主题化（Polaris token 类名），零第三方依赖。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { clsx } from 'clsx'

// ============================================================================
// 工具
// ============================================================================

/** YYYY-MM-DD（本地） */
function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 日期唯一键，用于比较（YYYMMDD） */
function dayKey(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
}

/** 某月的天数 */
function daysInMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate()
}

/** 周一为一周起点：getDay() 周日=0 → 周一=0 */
function dowMon(d: Date): number {
  return (d.getDay() + 6) % 7
}

// ============================================================================
// 类型
// ============================================================================

interface TimeRangePickerProps {
  /** 当前范围（均为本地 Date；可为空 = 不限） */
  start: Date | null
  end: Date | null
  /** 范围变化回调；任一为 null 表示不限 */
  onChange: (start: Date | null, end: Date | null) => void
  /** 可选：是否显示清空按钮 */
  allowClear?: boolean
  /** 可选：最小可选日期（默认不限） */
  minDate?: Date
  /** 可选：最大可选日期（默认不限，如今天） */
  maxDate?: Date
}

// ============================================================================
// 组件
// ============================================================================

export function TimeRangePicker({ start, end, onChange, allowClear = true, minDate, maxDate }: TimeRangePickerProps) {
  const { t } = useTranslation('settings')
  // 星期表头（周一为首）
  const weekdays = t('tokenStats.timeRange.weekdays', { returnObjects: true }) as unknown as string[]
  const WEEKDAYS = Array.isArray(weekdays) && weekdays.length === 7 ? weekdays : ['一', '二', '三', '四', '五', '六', '日']
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState<'start' | null>(null) // 'start' = 已选开始，待选结束
  const [hover, setHover] = useState<Date | null>(null)
  const [view, setView] = useState(() => {
    // 初始定位：已有开始则跳到开始所在月，否则当前月
    const base = start ?? new Date()
    return new Date(base.getFullYear(), base.getMonth(), 1)
  })
  const rootRef = useRef<HTMLDivElement>(null)

  const today = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])

  // 关闭时重置选点状态
  useEffect(() => {
    if (!open) {
      setPicking(null)
      setHover(null)
    }
  }, [open])

  // 点击组件外部关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // 视图改变时跟随（当外部范围变化）
  useEffect(() => {
    if (start) {
      setView(new Date(start.getFullYear(), start.getMonth(), 1))
    }
  }, [start])

  const y = view.getFullYear()
  const m = view.getMonth()

  // 面板网格：上月补位 + 本月 + 下月补位，凑 7 的倍数
  const cells = useMemo(() => {
    const firstDow = dowMon(new Date(y, m, 1))
    const dim = daysInMonth(y, m)
    const prevDim = daysInMonth(y, m - 1)
    const list: { d: Date; other: boolean }[] = []
    for (let i = firstDow - 1; i >= 0; i--) list.push({ d: new Date(y, m - 1, prevDim - i), other: true })
    for (let i = 1; i <= dim; i++) list.push({ d: new Date(y, m, i), other: false })
    const trail = (7 - (list.length % 7)) % 7
    for (let i = 1; i <= trail; i++) list.push({ d: new Date(y, m + 1, i), other: true })
    return list
  }, [y, m])

  const onPick = (d: Date) => {
    if (minDate && d < minDate) return
    if (maxDate && dayKey(d) > dayKey(maxDate)) return
    if (!picking && !start) {
      setPicking('start')
      setHover(null)
      return
    }
    if (picking === 'start') {
      if (start && dayKey(d) < dayKey(start)) {
        // 结束早于开始 → 重置为新的开始
        setStartOnly(d)
        return
      }
      onChange(start, d)
      setOpen(false)
      return
    }
    // 已有范围，重新点选开始
    setStartOnly(d)
  }

  /** 只设置开始（进入待选结束状态） */
  const setStartOnly = (d: Date) => {
    onChange(d, null)
    setPicking('start')
    setHover(null)
  }

  const rangeActive = start != null && end != null && dayKey(end) >= dayKey(start)
  const inRange = (d: Date): boolean => {
    if (!rangeActive || !start || !end) return false
    return dayKey(d) >= dayKey(start) && dayKey(d) <= dayKey(end)
  }

  const triggerText = start && end
    ? dayKey(start) === dayKey(end)
      ? fmtDate(start)
      : `${fmtDate(start)} ~ ${fmtDate(end)}`
    : null

  const monthLabel = `${y} 年 ${m + 1} 月`

  return (
    <div ref={rootRef} className="relative">
      {/* 触发器 */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={clsx(
          'flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-md border transition-colors min-w-[210px]',
          'bg-background-surface text-text-primary border-border-subtle',
          open ? 'border-primary' : 'hover:border-border-subtle hover:bg-background-hover',
        )}
      >
        <Calendar size={13} className="text-text-tertiary shrink-0" />
        <span className={clsx('flex-1 text-left tabular-nums truncate', !triggerText && 'text-text-tertiary')}>
          {triggerText ?? t('tokenStats.timeRange.placeholder', '选择时间范围')}
        </span>
        <ChevronDown size={13} className={clsx('text-text-tertiary shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {/* 日历弹层 */}
      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-50 w-[300px] p-3 rounded-xl border border-border bg-background-surface shadow-xl">
          {/* 表头：月份 + 翻页 */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-text-primary">{monthLabel}</span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setView(new Date(y, m - 1, 1))}
                className="w-6 h-6 flex items-center justify-center rounded-md text-text-secondary hover:bg-background-hover hover:text-text-primary"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                onClick={() => setView(new Date(y, m + 1, 1))}
                className="w-6 h-6 flex items-center justify-center rounded-md text-text-secondary hover:bg-background-hover hover:text-text-primary"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>

          {/* 星期表头（周一为首） */}
          <div className="grid grid-cols-7 text-center text-[10px] text-text-tertiary mb-1">
            {WEEKDAYS.map((w, wi) => (
              <span key={wi} className="py-0.5">{w}</span>
            ))}
          </div>

          {/* 日期网格 */}
          <div className="grid grid-cols-7 gap-y-0.5">
            {cells.map((c, i) => {
              const k = dayKey(c.d)
              const disabled = (minDate && c.d < minDate) || (maxDate && k > dayKey(maxDate))
              const isStart = rangeActive && start != null && k === dayKey(start)
              const isEnd = rangeActive && end != null && k === dayKey(end)
              const isToday = k === dayKey(today)
              const isPreview = picking === 'start' && start && hover && k > dayKey(start) && k <= dayKey(hover)
              return (
                <button
                  key={i}
                  type="button"
                  disabled={disabled}
                  onClick={() => onPick(c.d)}
                  onMouseEnter={() => { if (picking === 'start' && start) setHover(c.d) }}
                  className={clsx(
                    'h-8 text-xs rounded-md transition-colors relative',
                    c.other && !isStart && !isEnd ? 'text-text-tertiary opacity-40' : 'text-text-secondary',
                    isToday && !isStart && !isEnd && 'text-primary font-semibold',
                    inRange(c.d) && !isStart && !isEnd && 'bg-primary/10 text-text-primary',
                    isPreview && !isStart && !isEnd && 'bg-primary/10',
                    isStart && 'bg-primary text-white font-semibold rounded-r-none',
                    isEnd && 'bg-primary text-white font-semibold rounded-l-none',
                    disabled ? 'cursor-not-allowed opacity-30' : 'hover:bg-background-hover hover:text-text-primary',
                  )}
                >
                  {c.d.getDate()}
                  {isToday && <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-0.5 rounded-full bg-primary" />}
                </button>
              )
            })}
          </div>

          {/* 底部：提示 + 清空 */}
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-border-subtle text-[10px] text-text-tertiary">
            <span className="truncate pr-2">
              {picking === 'start' && start
                ? t('tokenStats.timeRange.pickEnd', { date: fmtDate(start) })
                : t('tokenStats.timeRange.pickStart')}
            </span>
            {allowClear && (start || end) && (
              <button
                type="button"
                onClick={() => { onChange(null, null); setPicking(null); setHover(null) }}
                className="shrink-0 text-text-tertiary hover:text-text-primary hover:bg-background-hover px-1.5 py-0.5 rounded"
              >
                {t('tokenStats.timeRange.clear', '清空')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default TimeRangePicker
