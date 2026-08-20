/**
 * Git 时间格式化工具函数
 *
 * 统一处理 Git 相关的时间戳格式化
 */

/**
 * 格式化 Git 时间戳
 * @param timestamp - Unix 时间戳（秒）
 * @param t - i18next 翻译函数
 * @returns 格式化后的时间字符串
 */
export function formatGitTimestamp(
  timestamp: number,
  t: (key: string, params?: Record<string, unknown>) => string
): string {
  const date = new Date(timestamp * 1000)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return t('history.justNow')
  if (diffMins < 60) return t('history.minutesAgo', { count: diffMins })
  if (diffHours < 24) return t('history.hoursAgo', { count: diffHours })
  if (diffDays < 7) return t('history.daysAgo', { count: diffDays })
  return date.toLocaleDateString()
}

/**
 * 简化的时间格式化（用于不需要详细翻译的场景）
 * @param timestamp - Unix 时间戳（秒）
 * @returns 格式化后的时间字符串
 */
export function formatGitTimeSimple(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return '刚刚'
  if (diffMins < 60) return `${diffMins}分钟前`
  if (diffHours < 24) return `${diffHours}小时前`
  if (diffDays < 7) return `${diffDays}天前`
  return date.toLocaleDateString()
}
