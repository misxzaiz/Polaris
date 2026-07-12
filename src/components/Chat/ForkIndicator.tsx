/**
 * Fork 关系指示器组件
 *
 * 显示会话的 Fork 关系和 PR 关联信息
 * 用于 SessionTree 和 SessionHistoryPanel 中
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch, GitPullRequest, ExternalLink, ChevronRight, ChevronDown } from 'lucide-react'
import type { LinkedPR } from '@/services/claudeCodeHistoryService'

export interface ForkIndicatorProps {
  /** 父会话 ID */
  parentSessionId?: string
  /** 子会话 ID 列表 */
  childSessionIds?: string[]
  /** Git 分支名称 */
  gitBranch?: string
  /** PR 关联信息 */
  linkedPr?: LinkedPR
  /** 紧凑模式 */
  compact?: boolean
  /** 点击父会话回调 */
  onNavigateToParent?: (sessionId: string) => void
  /** 点击子会话回调 */
  onNavigateToChild?: (sessionId: string) => void
  /** 点击 PR 回调 */
  onViewPR?: (pr: LinkedPR) => void
}

/**
 * Fork 关系指示器
 */
export function ForkIndicator({
  parentSessionId,
  childSessionIds,
  gitBranch,
  linkedPr,
  compact = false,
  onNavigateToParent,
  onNavigateToChild,
  onViewPR,
}: ForkIndicatorProps) {
  const { t } = useTranslation('chat')
  const [childrenExpanded, setChildrenExpanded] = useState(false)

  const hasForkRelation = parentSessionId || (childSessionIds && childSessionIds.length > 0)
  const hasPr = !!linkedPr
  const hasGitBranch = !!gitBranch

  if (!hasForkRelation && !hasPr && !hasGitBranch) {
    return null
  }

  // 紧凑模式：单行显示
  if (compact) {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        {hasPr && linkedPr && (
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400">
            <GitPullRequest className="w-3 h-3" />
            <span>#{linkedPr.number}</span>
          </span>
        )}
        {hasGitBranch && (
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
            <GitBranch className="w-3 h-3" />
            <span className="truncate max-w-[80px]">{gitBranch}</span>
          </span>
        )}
        {parentSessionId && (
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
            <GitBranch className="w-3 h-3" />
            <span>Fork</span>
          </span>
        )}
        {childSessionIds && childSessionIds.length > 0 && (
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
            <GitBranch className="w-3 h-3" />
            <span>{childSessionIds.length} 分支</span>
          </span>
        )}
      </div>
    )
  }

  // 完整模式：详细信息展示
  return (
    <div className="space-y-1.5 text-xs">
      {/* PR 关联 */}
      {hasPr && linkedPr && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-800">
          <GitPullRequest className="w-3.5 h-3.5 text-violet-500" />
          <div className="flex-1 min-w-0">
            <span className="font-medium text-violet-600 dark:text-violet-400">
              PR #{linkedPr.number}
            </span>
            {linkedPr.title && (
              <span className="ml-1 text-violet-500 dark:text-violet-400 truncate">
                {linkedPr.title}
              </span>
            )}
          </div>
          {linkedPr.state && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
              linkedPr.state === 'open'
                ? 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400'
                : linkedPr.state === 'merged'
                  ? 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400'
                  : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
            }`}>
              {linkedPr.state}
            </span>
          )}
          {onViewPR && (
            <button
              onClick={() => onViewPR(linkedPr)}
              className="p-0.5 rounded hover:bg-violet-200 dark:hover:bg-violet-800 text-violet-500"
              title={t('history.viewPr')}
            >
              <ExternalLink className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {/* Git 分支 */}
      {hasGitBranch && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
          <GitBranch className="w-3.5 h-3.5 text-slate-500" />
          <span className="text-slate-600 dark:text-slate-400 truncate">{gitBranch}</span>
        </div>
      )}

      {/* Fork 关系 */}
      {hasForkRelation && (
        <div className="space-y-1">
          {/* 父会话 */}
          {parentSessionId && (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
              <GitBranch className="w-3.5 h-3.5 text-amber-500" />
              <span className="text-amber-600 dark:text-amber-400">
                {t('history.forkedFrom')}
              </span>
              {onNavigateToParent ? (
                <button
                  onClick={() => onNavigateToParent(parentSessionId)}
                  className="text-amber-500 hover:text-amber-600 dark:hover:text-amber-300 hover:underline truncate max-w-[120px]"
                >
                  {parentSessionId.slice(0, 8)}...
                </button>
              ) : (
                <span className="text-amber-500 truncate max-w-[120px]">
                  {parentSessionId.slice(0, 8)}...
                </span>
              )}
            </div>
          )}

          {/* 子会话列表 */}
          {childSessionIds && childSessionIds.length > 0 && (
            <div className="px-2 py-1.5 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
              <button
                onClick={() => setChildrenExpanded(!childrenExpanded)}
                className="flex items-center gap-2 w-full text-left"
              >
                {childrenExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-amber-500" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-amber-500" />
                )}
                <GitBranch className="w-3.5 h-3.5 text-amber-500" />
                <span className="text-amber-600 dark:text-amber-400">
                  {t('history.childSessions', { count: childSessionIds.length })}
                </span>
              </button>

              {childrenExpanded && (
                <div className="mt-1.5 ml-6 space-y-1">
                  {childSessionIds.map((childId) => (
                    <div key={childId} className="flex items-center gap-2">
                      <span className="text-amber-500">└</span>
                      {onNavigateToChild ? (
                        <button
                          onClick={() => onNavigateToChild(childId)}
                          className="text-amber-500 hover:text-amber-600 dark:hover:text-amber-300 hover:underline text-[11px]"
                        >
                          {childId.slice(0, 8)}...
                        </button>
                      ) : (
                        <span className="text-amber-500 text-[11px]">
                          {childId.slice(0, 8)}...
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Fork 树形连接线组件
 */
export interface ForkTreeLineProps {
  /** 是否为根节点 */
  isRoot?: boolean
  /** 是否为最后一个子节点 */
  isLast?: boolean
  /** 是否有子节点 */
  hasChildren?: boolean
  /** 是否展开 */
  expanded?: boolean
}

export function ForkTreeLine({
  isRoot = false,
  isLast = false,
  hasChildren = false,
  expanded = false,
}: ForkTreeLineProps) {
  return (
    <div className="flex items-center self-stretch">
      {/* 垂直连接线（非根节点） */}
      {!isRoot && (
        <div className={`w-4 h-full flex items-center justify-end ${isLast ? 'pb-2' : ''}`}>
          <div className={`w-3 h-0.5 bg-amber-300 dark:bg-amber-700`} />
          {!isLast && (
            <div className="absolute w-0.5 h-full bg-amber-300 dark:bg-amber-700 -translate-x-3.5" />
          )}
        </div>
      )}

      {/* 展开/折叠图标 */}
      {hasChildren && (
        <div className="w-4 h-4 flex items-center justify-center text-amber-500">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </div>
      )}
    </div>
  )
}

export default ForkIndicator
