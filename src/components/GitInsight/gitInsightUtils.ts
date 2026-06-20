/**
 * Git Insight 数据聚合工具
 *
 * 输入来自后端 `git_get_log` 的 GitCommit[]（timestamp 为 Unix 秒），
 * 纯前端聚合出贡献者分布、提交时间热度、活跃度概览。
 * 不触发任何额外 IPC，不执行写操作。
 */
import type { GitCommit } from '@/types/git'

export interface ContributorStat {
  name: string
  email: string
  count: number
  firstCommitAt: number // ms
  lastCommitAt: number // ms
}

export interface DailyStat {
  date: string // YYYY-MM-DD（本地时区）
  count: number
}

export interface InsightSummary {
  totalCommits: number
  contributorCount: number
  firstCommitAt: number | null // ms
  lastCommitAt: number | null // ms
  spanDays: number
  avgPerDay: number
  topContributors: ContributorStat[]
  daily: DailyStat[]
  truncated: boolean
}

const MS_PER_DAY = 86_400_000

function toMs(seconds: number): number {
  return seconds * 1000
}

function toLocalDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 聚合提交历史为分析摘要。
 *
 * @param commits  从 git_get_log 拉取的提交（顺序无关）
 * @param truncated 是否因达到累积上限被截断
 */
export function buildInsightSummary(
  commits: GitCommit[],
  truncated = false,
): InsightSummary {
  const contributorMap = new Map<string, ContributorStat>()
  const dailyMap = new Map<string, number>()

  let firstMs: number | null = null
  let lastMs: number | null = null

  for (const c of commits) {
    const ms = toMs(c.timestamp ?? 0)

    // 贡献者聚合：以 email 为主键，name 取最近一次（commits 倒序时即首个出现）
    const key = c.authorEmail || c.author || 'unknown'
    const existing = contributorMap.get(key)
    if (existing) {
      existing.count += 1
      if (ms < existing.firstCommitAt) existing.firstCommitAt = ms
      if (ms > existing.lastCommitAt) existing.lastCommitAt = ms
      // 保留首次记录的 name，避免同名不同 email 抖动；email 缺失时回退 name
      if (!existing.email && c.authorEmail) existing.email = c.authorEmail
    } else {
      contributorMap.set(key, {
        name: c.author || 'unknown',
        email: c.authorEmail || '',
        count: 1,
        firstCommitAt: ms,
        lastCommitAt: ms,
      })
    }

    // 按天聚合
    const dateKey = toLocalDateKey(ms)
    dailyMap.set(dateKey, (dailyMap.get(dateKey) ?? 0) + 1)

    if (firstMs === null || ms < firstMs) firstMs = ms
    if (lastMs === null || ms > lastMs) lastMs = ms
  }

  const topContributors = Array.from(contributorMap.values())
    .sort((a, b) => b.count - a.count || b.lastCommitAt - a.lastCommitAt)

  // 按日期升序输出，便于折线图渲染
  const daily = Array.from(dailyMap.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  const spanDays =
    firstMs !== null && lastMs !== null
      ? Math.max(1, Math.round((lastMs - firstMs) / MS_PER_DAY) + 1)
      : 0

  return {
    totalCommits: commits.length,
    contributorCount: contributorMap.size,
    firstCommitAt: firstMs,
    lastCommitAt: lastMs,
    spanDays,
    avgPerDay: spanDays > 0 ? commits.length / spanDays : 0,
    topContributors,
    daily,
    truncated,
  }
}

/** 取最近 N 天的每日提交数（不足则补零），用于热度图/折线。 */
export function recentDaily(daily: DailyStat[], days: number): DailyStat[] {
  if (daily.length === 0) return []
  const out: DailyStat[] = []
  const last = new Date(daily[daily.length - 1].date)
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(last)
    d.setDate(d.getDate() - i)
    const key = toLocalDateKey(d.getTime())
    out.push({ date: key, count: 0 })
  }
  const lookup = new Map(daily.map((d) => [d.date, d.count]))
  for (const slot of out) {
    slot.count = lookup.get(slot.date) ?? 0
  }
  return out
}

/** 单个贡献者占总提交的百分比（保留 1 位小数）。 */
export function sharePct(count: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((count / total) * 1000) / 10
}
