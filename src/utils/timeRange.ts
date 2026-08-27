/**
 * 时间范围工具函数
 *
 * 为 Token 统计页的快捷时间范围与联动日历选择器提供统一的起止计算。
 * 输出统一为「本地 Date」，组件负责转换成 Unix 秒（见 dateToUnixSeconds）。
 */

/** 本地 Date → Unix 秒（秒级精度） */
export function dateToUnixSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000)
}

/** 某天的 00:00:00（本地时间） */
export function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/** 某天的 23:59:59.999（本地时间） */
export function endOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

/** 相对某天偏移 n 天 */
export function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

/** 今天 00:00:00 */
export function todayStart(): Date {
  return startOfDay(new Date())
}

/** 今天 23:59:59.999 */
export function todayEnd(): Date {
  return endOfDay(new Date())
}

/**
 * 快捷预设时间范围
 *
 * 返回 [start, end]（均为本地 Date；end 为该范围最后一刻）。
 * - 单日项：当天 00:00:00 ~ 23:59:59.999
 * - 滚动项：今天起往前 N 天滚动
 * - 上周：上一自然周（周一 00:00 ~ 周日 23:59）
 * - 上月：上一自然月（1 日 00:00 ~ 月末 23:59）
 * - 全部：返回 null（表示不限时间范围）
 */
export function presetRange(preset: string): [Date, Date] | null {
  const now = new Date()
  switch (preset) {
    case 'today':
      return [startOfDay(now), endOfDay(now)]
    case 'yesterday': {
      const y = addDays(now, -1)
      return [startOfDay(y), endOfDay(y)]
    }
    case 'dayBefore': {
      const y = addDays(now, -2)
      return [startOfDay(y), endOfDay(y)]
    }
    case 'rolling7': {
      return [startOfDay(addDays(now, -6)), endOfDay(now)]
    }
    case 'rolling30': {
      return [startOfDay(addDays(now, -29)), endOfDay(now)]
    }
    case 'lastWeek': {
      // 周一为一周起点（ISO 周：getDay() 周日=0 → 周一=1，转成 周一=0 偏移）
      const dow = (now.getDay() + 6) % 7
      const monday = addDays(startOfDay(now), -dow - 7)
      return [monday, endOfDay(addDays(monday, 6))]
    }
    case 'lastMonth': {
      const y = now.getFullYear()
      const m = now.getMonth()
      const first = new Date(y, m - 1, 1)
      const last = new Date(y, m, 0) // 上个月最后一天
      return [startOfDay(first), endOfDay(last)]
    }
    case 'all':
      return null
    default:
      return null
  }
}
