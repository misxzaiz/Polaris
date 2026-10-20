/**
 * 提交前风险扫描卡片（P3 AI-3：PR 式提交前 Review 门，纯本地零 AI）
 *
 * 对齐 handoff FR-P3-AI3：AI-3 本地扫描 = 提交前 PR 形式 Review 门 ——
 * 只列事实不阻断（secret / conflict-marker / large-file 三类，
 * 后端 risk_scan.rs 对暂存区逐新增行扫描）。
 *
 * 挂载：GitPanel index 变更区（CommitInput 旁）。扫描手动触发/auto-on-mount，
 * 结果存 gitStore.riskScanByWs[workspacePath]。
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore'

interface CommitRiskCardProps {
  workspacePath: string
  /** A2 明细跳转：点击发现条目 → 打开该文件（暂存区）diff */
  onOpenFileDiff?: (filePath: string) => void
}

const CATEGORY_CLASS: Record<string, string> = {
  secret: 'text-danger',
  'conflict-marker': 'text-warning',
  'large-file': 'text-text-secondary',
}

export function CommitRiskCard({ workspacePath, onOpenFileDiff }: CommitRiskCardProps) {
  const { t } = useTranslation('git')
  const report = useGitStore((s) => (workspacePath ? (s.riskScanByWs?.[workspacePath] ?? null) : null))
  const scanCommitRisk = useGitStore((s) => s.scanCommitRisk)
  const [isLoading, setIsLoading] = useState(false)

  const scan = () => {
    if (!workspacePath) return
    setIsLoading(true)
    scanCommitRisk(workspacePath)
      .catch(() => {
        // 扫描失败静默（卡片条目隐藏，提交主流程不受阻——Review 门不阻断）
      })
      .finally(() => setIsLoading(false))
  }

  // 挂载/仓库切换时自动扫一次（Review 门 = 提交前常态提示）；刷新由按钮承担
  useEffect(() => {
    scan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath])

  if (isLoading && !report) {
    return (
      <div className="px-4 py-2 border-b border-border-subtle bg-background-surface flex items-center gap-1.5 text-xs text-text-tertiary">
        <Loader2 size={12} className="animate-spin" />
        {t('riskScan.scanning')}
      </div>
    )
  }

  const findings = report?.findings ?? []
  const secretCount = findings.filter((f) => f.category === 'secret').length
  const markerCount = findings.filter((f) => f.category === 'conflict-marker').length
  const largeCount = findings.filter((f) => f.category === 'large-file').length

  return (
    <div className="px-4 py-2 border-b border-border-subtle bg-background-surface">
      <div className="flex items-center gap-1 mb-1">
        <span className="text-xs font-semibold text-text-primary">✦ {t('riskScan.title')}</span>
        <span className="text-[10px] text-text-tertiary ml-auto">{t('riskScan.badge')}</span>
        <button
          type="button"
          className="p-0.5 text-text-tertiary hover:text-primary rounded transition-colors"
          onClick={scan}
          title={t('riskScan.rescan')}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {findings.length === 0 ? (
        <div className="text-xs text-success">{t('riskScan.clean')}</div>
      ) : (
        <div className="text-xs text-text-secondary leading-relaxed">
          {/* 摘要行：秘密/冲突 marker/大文件 计数 */}
          <span className="items-center gap-1 inline-flex flex-wrap">
            {secretCount > 0 && (
              <span className="text-danger inline-flex items-center gap-1">
                <AlertTriangle size={10} />
                {t('riskScan.summarySecret', { count: secretCount })}
              </span>
            )}
            {markerCount > 0 && (
              <span className="text-warning">{t('riskScan.summaryMarker', { count: markerCount })}</span>
            )}
            {largeCount > 0 && (
              <span className="text-text-secondary">{t('riskScan.summaryLarge', { count: largeCount })}</span>
            )}
          </span>

          {/* 明细（上限展示 8 条；截断提示走 footer） */}
          <ul className="mt-1 space-y-0.5">
            {findings.slice(0, 8).map((f, i) => {
              const handleOpen = onOpenFileDiff
                ? () => onOpenFileDiff(f.file)
                : undefined
              return (
                <li
                  key={`${f.file}:${f.line ?? 'na'}:${i}`}
                  className={`flex items-baseline gap-1.5 min-w-0 ${handleOpen ? 'cursor-pointer hover:bg-background-hover rounded transition-colors' : ''}`}
                  onClick={handleOpen}
                  onKeyDown={(e) => { if (handleOpen && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); handleOpen() } }}
                  role={handleOpen ? 'button' : undefined}
                  tabIndex={handleOpen ? 0 : undefined}
                  title={handleOpen ? t('riskScan.openDiff') : undefined}
                  data-testid="risk-finding-item"
                >
                  <span className={`shrink-0 ${CATEGORY_CLASS[f.category] ?? 'text-text-secondary'}`}>
                    {t(`riskScan.category.${f.category}`, { defaultValue: f.category })}
                  </span>
                  <span className="font-mono text-[11px] text-text-secondary truncate">
                    {f.file}{f.line != null ? `:${f.line}` : ''}
                  </span>
                  <span className="text-[11px] text-text-tertiary truncate">{f.excerpt}</span>
                </li>
              )
            })}
          </ul>
          {findings.length > 8 && (
            <div className="mt-0.5 text-[10px] text-text-tertiary">
              {t('riskScan.more', { count: findings.length - 8 })}
            </div>
          )}
          {report?.truncated && (
            <div className="mt-0.5 text-[10px] text-warning">
              {t('riskScan.truncated')}
            </div>
          )}
          <div className="mt-1 text-[10px] text-text-tertiary">{t('riskScan.hint')}</div>
        </div>
      )}
    </div>
  )
}
