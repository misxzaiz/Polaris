/**
 * 冲突常驻提示条（P3 FR-P3-1：status 层入口）
 *
 * 当 `GitRepositoryStatus.conflicted` 非空时显示顶部横幅，点击打开冲突合并器。
 * 数据由 status 驱动（高频轻量），合并器数据源是 `get_conflict_state`（Host 自动补齐）。
 */

import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'

interface ConflictBannerProps {
  workspacePath: string
  conflicted: string[]
}

export function ConflictBanner({ workspacePath, conflicted }: ConflictBannerProps) {
  const { t } = useTranslation('git')
  const openMerger = useGitStore((s) => s.openMerger)

  if (!conflicted || conflicted.length === 0) return null

  return (
    <div className="px-3 py-2 bg-warning/10 border-b border-warning/30 flex items-center gap-2 cursor-pointer hover:bg-warning/15 transition-colors"
      onClick={() => openMerger(workspacePath)}
      data-testid="conflict-banner"
    >
      <AlertTriangle size={14} className="text-warning shrink-0" />
      <span className="text-xs text-warning font-medium">
        {t('conflict.banner', { count: conflicted.length })}
      </span>
      <span className="text-xs text-warning/70">{t('conflict.bannerAction')}</span>
      <ChevronRight size={12} className="text-warning/50 ml-auto shrink-0" />
    </div>
  )
}