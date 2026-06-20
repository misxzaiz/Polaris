/**
 * Git Insight 面板（内置插件 panel）
 *
 * 只读提交历史分析。独立 invoke git_get_log 拉取（不复用 gitStore，
 * 避免污染 GitPanel 共享的 commits 状态），前端聚合后渲染：
 *  - 活跃度概览（总提交 / 贡献者 / 时间跨度 / 日均）
 *  - 贡献者排行
 *  - 最近 30 天提交热度
 * 支持手动刷新，以及将分析摘要一键发送到对话。
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  GitGraph,
  RefreshCw,
  Send,
  Users,
  CalendarDays,
  TrendingUp,
  AlertCircle,
  Inbox,
} from 'lucide-react'
import { invoke } from '@/services/transport'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { GitCommit } from '@/types/git'
import { createLogger } from '@/utils/logger'
import {
  buildInsightSummary,
  recentDaily,
  sharePct,
  type InsightSummary,
} from './gitInsightUtils'

const log = createLogger('GitInsightPanel')

const FETCH_BATCH = 200
const FETCH_MAX = 2000
const TOP_CONTRIBUTORS = 8
const HEATMAP_DAYS = 30

type LoadStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'notRepo' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; commits: GitCommit[]; truncated: boolean }

interface GitInsightPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

async function fetchAllCommits(workspacePath: string): Promise<{ commits: GitCommit[]; truncated: boolean }> {
  const out: GitCommit[] = []
  let skip = 0
  while (out.length < FETCH_MAX) {
    const batch = await invoke<GitCommit[]>('git_get_log', {
      workspacePath,
      limit: FETCH_BATCH,
      skip,
      branch: null,
    })
    if (!batch.length) break
    out.push(...batch)
    if (batch.length < FETCH_BATCH) break
    skip += batch.length
  }
  return { commits: out, truncated: out.length >= FETCH_MAX }
}

function buildSummaryText(s: InsightSummary, t: (k: string, opts?: Record<string, unknown>) => string): string {
  const lines: string[] = []
  lines.push(`# ${t('gitInsight.summaryTitle')}`)
  lines.push(`- ${t('gitInsight.sumTotal')}: ${s.totalCommits}${s.truncated ? t('gitInsight.sumTruncated') : ''}`)
  lines.push(`- ${t('gitInsight.sumContributors')}: ${s.contributorCount}`)
  lines.push(`- ${t('gitInsight.sumSpan')}: ${t('gitInsight.sumSpanValue', { days: s.spanDays, avg: s.avgPerDay.toFixed(2) })}`)
  lines.push(`- ${t('gitInsight.sumTop')}:`)
  for (const c of s.topContributors.slice(0, 5)) {
    lines.push(`  - ${c.name} (${sharePct(c.count, s.totalCommits)}%): ${c.count}`)
  }
  return lines.join('\n')
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString()
}

export function GitInsightPanel({ pluginId, onSendToChat }: GitInsightPanelProps) {
  void pluginId
  const { t } = useTranslation()

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId)
  const viewingWorkspaceId = useWorkspaceStore((s) => s.viewingWorkspaceId)

  const workspacePath = useMemo(() => {
    const targetId = viewingWorkspaceId || currentWorkspaceId
    const ws = workspaces.find((w) => w.id === targetId)
    return ws?.path ?? null
  }, [workspaces, currentWorkspaceId, viewingWorkspaceId])

  const [status, setStatus] = useState<LoadStatus>({ kind: 'idle' })
  const [refreshKey, setRefreshKey] = useState(0)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!workspacePath) {
      setStatus({ kind: 'idle' })
      return
    }
    setStatus({ kind: 'loading' })
    let cancelled = false
    ;(async () => {
      try {
        const isRepo = await invoke<boolean>('git_is_repository', { workspacePath })
        if (!isRepo) {
          if (!cancelled) setStatus({ kind: 'notRepo' })
          return
        }
        const { commits, truncated } = await fetchAllCommits(workspacePath)
        if (cancelled) return
        if (commits.length === 0) {
          setStatus({ kind: 'empty' })
        } else {
          setStatus({ kind: 'ready', commits, truncated })
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        log.error('load git insight failed', e instanceof Error ? e : new Error(message))
        if (!cancelled) setStatus({ kind: 'error', message })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspacePath, refreshKey])

  const summary = useMemo<InsightSummary | null>(
    () => (status.kind === 'ready' ? buildInsightSummary(status.commits, status.truncated) : null),
    [status],
  )

  const heatmap = useMemo(
    () => (summary ? recentDaily(summary.daily, HEATMAP_DAYS) : []),
    [summary],
  )

  const maxContributorCount = summary?.topContributors[0]?.count ?? 0
  const maxDailyCount = useMemo(() => Math.max(1, ...heatmap.map((d) => d.count)), [heatmap])

  const handleSendSummary = async () => {
    if (!summary || !onSendToChat) return
    setSending(true)
    try {
      await onSendToChat(buildSummaryText(summary, t))
    } catch (e) {
      log.error('send summary failed', e instanceof Error ? e : new Error(String(e)))
    } finally {
      setSending(false)
    }
  }

  // —— 状态分支 ——
  if (!workspacePath || status.kind === 'idle') {
    return (
      <EmptyState icon={<Inbox size={28} className="text-text-tertiary" />}>
        <div className="text-sm font-medium text-text-primary">{t('gitInsight.noWorkspace')}</div>
        <div className="max-w-xs text-xs text-text-tertiary">{t('gitInsight.noWorkspaceHint')}</div>
      </EmptyState>
    )
  }

  if (status.kind === 'loading') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6">
        <RefreshCw size={20} className="animate-spin text-text-tertiary" />
        <div className="text-xs text-text-muted">{t('gitInsight.loading')}</div>
      </div>
    )
  }

  if (status.kind === 'notRepo') {
    return (
      <EmptyState icon={<GitGraph size={28} className="text-text-tertiary" />}>
        <div className="text-sm font-medium text-text-primary">{t('gitInsight.notRepo')}</div>
        <div className="max-w-xs text-xs text-text-tertiary">{t('gitInsight.notRepoHint')}</div>
      </EmptyState>
    )
  }

  if (status.kind === 'error') {
    return (
      <EmptyState icon={<AlertCircle size={28} className="text-status-error" />}>
        <div className="text-sm font-medium text-text-primary">{t('gitInsight.errorTitle')}</div>
        <div className="max-w-xs break-all text-xs text-text-tertiary">{status.message}</div>
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-background-hover"
        >
          <RefreshCw size={12} /> {t('gitInsight.retry')}
        </button>
      </EmptyState>
    )
  }

  if (status.kind === 'empty') {
    return (
      <EmptyState icon={<Inbox size={28} className="text-text-tertiary" />}>
        <div className="text-sm font-medium text-text-primary">{t('gitInsight.empty')}</div>
        <div className="max-w-xs text-xs text-text-tertiary">{t('gitInsight.emptyHint')}</div>
      </EmptyState>
    )
  }

  if (!summary) return null

  // —— ready 渲染 ——
  return (
    <div className="flex h-full flex-col">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
          <GitGraph size={13} className="text-primary" />
          {t('gitInsight.title')}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            title={t('gitInsight.refresh')}
            className="rounded p-1 text-text-tertiary hover:bg-background-hover hover:text-text-secondary"
          >
            <RefreshCw size={13} />
          </button>
          {onSendToChat && (
            <button
              onClick={handleSendSummary}
              disabled={sending}
              title={t('gitInsight.sendSummary')}
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              <Send size={12} /> {t('gitInsight.sendSummary')}
            </button>
          )}
        </div>
      </div>

      {/* 滚动区 */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {summary.truncated && (
          <div className="mb-3 rounded-md border border-border-subtle bg-background-elevated px-2.5 py-1.5 text-[11px] text-text-tertiary">
            {t('gitInsight.truncatedHint', { max: FETCH_MAX })}
          </div>
        )}

        {/* 概览卡片 */}
        <div className="grid grid-cols-2 gap-2">
          <StatCard
            icon={<TrendingUp size={13} />}
            label={t('gitInsight.totalCommits')}
            value={String(summary.totalCommits)}
          />
          <StatCard
            icon={<Users size={13} />}
            label={t('gitInsight.contributors')}
            value={String(summary.contributorCount)}
          />
          <StatCard
            icon={<CalendarDays size={13} />}
            label={t('gitInsight.spanDays')}
            value={String(summary.spanDays)}
          />
          <StatCard
            icon={<TrendingUp size={13} />}
            label={t('gitInsight.avgPerDay')}
            value={summary.avgPerDay.toFixed(2)}
          />
        </div>

        {/* 时间范围 */}
        {summary.firstCommitAt !== null && summary.lastCommitAt !== null && (
          <div className="mt-2 text-[11px] text-text-muted">
            {t('gitInsight.range', {
              from: formatDate(summary.firstCommitAt),
              to: formatDate(summary.lastCommitAt),
            })}
          </div>
        )}

        {/* 贡献者排行 */}
        <Section title={t('gitInsight.topContributors')}>
          <div className="flex flex-col gap-1.5">
            {summary.topContributors.slice(0, TOP_CONTRIBUTORS).map((c) => (
              <div key={c.email || c.name} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="truncate text-text-secondary" title={c.email || c.name}>
                    {c.name}
                  </span>
                  <span className="shrink-0 text-text-muted">
                    {c.count} · {sharePct(c.count, summary.totalCommits)}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-background-elevated">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${(c.count / maxContributorCount) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* 提交热度（最近 30 天） */}
        <Section title={t('gitInsight.heatmapTitle', { days: HEATMAP_DAYS })}>
          {heatmap.every((d) => d.count === 0) ? (
            <div className="text-[11px] text-text-muted">{t('gitInsight.heatmapEmpty')}</div>
          ) : (
            <div className="flex items-end gap-[2px]" style={{ height: 48 }}>
              {heatmap.map((d) => (
                <div
                  key={d.date}
                  title={`${d.date}: ${d.count}`}
                  className="flex-1 rounded-sm bg-primary/15"
                  style={{
                    height: `${(d.count / maxDailyCount) * 100}%`,
                    minHeight: d.count > 0 ? 3 : 0,
                    backgroundColor: d.count > 0 ? undefined : 'transparent',
                  }}
                >
                  {d.count > 0 && (
                    <div className="h-full w-full rounded-sm bg-primary/70" />
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}

function EmptyState({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      {icon}
      {children}
    </div>
  )
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-subtle bg-background-elevated px-2.5 py-2">
      <div className="flex items-center gap-1 text-text-tertiary">{icon}</div>
      <div className="mt-1 text-base font-semibold text-text-primary">{value}</div>
      <div className="text-[11px] text-text-muted">{label}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <div className="mb-2 text-xs font-medium text-text-primary">{title}</div>
      {children}
    </div>
  )
}

export default GitInsightPanel
