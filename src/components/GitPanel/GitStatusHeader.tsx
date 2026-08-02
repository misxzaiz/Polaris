import { useTranslation } from 'react-i18next'
import { ArrowUpDown, RefreshCw } from 'lucide-react'
import { BranchSelector } from './BranchSelector'
import type { GitRepositoryStatus } from '@/types'

interface GitStatusHeaderProps {
  status: GitRepositoryStatus | null
  isLoading: boolean
  onRefresh: () => void
}

export function GitStatusHeader({ status, isLoading, onRefresh }: GitStatusHeaderProps) {
  const { t } = useTranslation('git')

  if (!status) {
    return (
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <span className="text-sm text-text-tertiary">{t('notGitRepo')}</span>
      </div>
    )
  }

  if (status.isEmpty) {
    return (
      <div className="px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BranchSelector />
            <span className="text-text-tertiary text-xs">{t('noCommits')}</span>
          </div>
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
            title={t('refreshStatus')}
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="px-4 py-3 border-b border-border-subtle">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BranchSelector />
          {status.commit && (
            <span className="text-text-tertiary text-xs font-mono">
              {status.shortCommit}
            </span>
          )}
        </div>
        
        <button
          onClick={onRefresh}
          disabled={isLoading}
          className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
          title={t('refreshStatus')}
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {(status.ahead > 0 || status.behind > 0) && (
        <div className="flex items-center gap-3 text-xs text-text-secondary mt-2">
          {status.ahead > 0 && (
            <span className="flex items-center gap-1" title={t('aheadRemote')}>
              <ArrowUpDown size={12} className="text-success rotate-180" />
              +{status.ahead}
            </span>
          )}
          {status.behind > 0 && (
            <span className="flex items-center gap-1" title={t('behindRemote')}>
              <ArrowUpDown size={12} className="text-warning" />
              -{status.behind}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
