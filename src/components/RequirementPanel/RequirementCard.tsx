/**
 * RequirementCard - 单个需求卡片
 *
 * 展示需求状态、标题、描述预览、优先级、标签、来源、原型标识、时间戳和操作按钮
 */

import {
  FileEdit,
  Trash2,
  Check,
  X,
  Sparkles,
  User,
  Eye,
  Play,
  FolderOpen,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Requirement } from '@/types/requirement'
import { STATUS_STYLES, PRIORITY_TEXT, PRIORITY_BG, formatTime } from './constants'

interface RequirementCardProps {
  requirement: Requirement
  /** 是否显示工作区名称（当 scope=all 时） */
  showWorkspace?: boolean
  disabled?: boolean
  onEditClick?: (requirement: Requirement) => void
  onApproveClick?: (requirement: Requirement) => void
  onRejectClick?: (requirement: Requirement) => void
  onDeleteClick?: (requirement: Requirement) => void
  onExecuteClick?: (requirement: Requirement) => void
  onClick?: (requirement: Requirement) => void
}

export function RequirementCard({
  requirement,
  showWorkspace = false,
  disabled,
  onEditClick,
  onApproveClick,
  onRejectClick,
  onDeleteClick,
  onExecuteClick,
  onClick,
}: RequirementCardProps) {
  const { t, i18n } = useTranslation('requirement')

  const style = STATUS_STYLES[requirement.status]
  const priorityStyle = `${PRIORITY_TEXT[requirement.priority]} ${PRIORITY_BG[requirement.priority]}`
  const canReview = requirement.status === 'pending' || requirement.status === 'draft'

  return (
    <div
      role="button"
      tabIndex={0}
      className={`p-3 rounded-lg border transition-all hover:shadow-sm cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
        requirement.status === 'executing'
          ? 'bg-status-info/5 border-status-info/30'
          : requirement.status === 'completed'
          ? 'bg-status-done/5 border-status-done/30 opacity-60'
          : 'bg-background-surface border-border-subtle hover:border-border'
      }`}
      onClick={() => onClick?.(requirement)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick?.(requirement)
        }
      }}
    >
      <div className="flex items-start gap-2">
        {/* 状态指示点 */}
        <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${style.dot}`} />

        <div className="flex-1 min-w-0">
          {/* 标题行 */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-text-primary truncate">
              {requirement.title || t('form.titlePlaceholder')}
            </span>
            {/* 优先级标签 */}
            <span className={`px-1.5 py-0.5 text-xs rounded flex-shrink-0 ${priorityStyle}`}>
              {t(`priority.${requirement.priority}`)}
            </span>
          </div>

          {/* 描述预览 */}
          {requirement.description && (
            <p className="mt-1 text-xs text-text-secondary line-clamp-2">
              {requirement.description}
            </p>
          )}

          {/* 标签 + 来源 + 原型 */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {/* 标签 */}
            {requirement.tags.map(tag => (
              <span
                key={tag}
                className="px-1.5 py-0.5 text-xs text-text-tertiary bg-background-tertiary rounded"
              >
                {tag}
              </span>
            ))}

            {/* 来源标识 */}
            <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs rounded ${
              requirement.generatedBy === 'ai'
                ? 'text-accent-ai bg-accent-ai/10'
                : 'text-text-tertiary bg-background-tertiary'
            }`}>
              {requirement.generatedBy === 'ai' ? (
                <><Sparkles size={10} /> {t('source.ai')}</>
              ) : (
                <><User size={10} /> {t('source.user')}</>
              )}
            </span>

            {/* 原型标识 */}
            {requirement.hasPrototype && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs text-accent-prototype bg-accent-prototype/10 rounded">
                <Eye size={10} />
                {t('card.prototype')}
              </span>
            )}

            {/* 工作区标识（仅在显示所有工作区时） */}
            {showWorkspace && requirement.workspaceName && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs text-accent-workspace bg-accent-workspace/10 rounded">
                <FolderOpen size={10} />
                {requirement.workspaceName}
              </span>
            )}
          </div>

          {/* 时间戳 */}
          <div className="mt-1.5 text-xs text-text-muted">
            {formatTime(requirement.createdAt, i18n.language)}
          </div>
        </div>

        {/* 操作按钮组 */}
        <div className={`flex items-center gap-0.5 flex-shrink-0 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
          {canReview && (
            <>
              <button
                onClick={e => { e.stopPropagation(); onApproveClick?.(requirement) }}
                className="p-1.5 rounded hover:bg-status-success/10 text-text-secondary hover:text-status-success transition-all"
                title={t('card.approve')}
                aria-label={t('card.approve')}
                disabled={disabled}
              >
                <Check size={14} />
              </button>
              <button
                onClick={e => { e.stopPropagation(); onRejectClick?.(requirement) }}
                className="p-1.5 rounded hover:bg-status-danger/10 text-text-secondary hover:text-status-danger transition-all"
                title={t('card.reject')}
                aria-label={t('card.reject')}
                disabled={disabled}
              >
                <X size={14} />
              </button>
            </>
          )}

          {requirement.status === 'approved' && onExecuteClick && (
            <button
              onClick={e => { e.stopPropagation(); onExecuteClick(requirement) }}
              className="p-1.5 rounded hover:bg-status-info/10 text-text-secondary hover:text-status-info transition-all"
              title={t('execute')}
              aria-label={t('execute')}
              disabled={disabled}
            >
              <Play size={14} />
            </button>
          )}

          <button
            onClick={e => { e.stopPropagation(); onEditClick?.(requirement) }}
            className="p-1.5 rounded hover:bg-background-hover text-text-secondary hover:text-text-primary transition-all"
            title={t('card.edit')}
            aria-label={t('card.edit')}
            disabled={disabled}
          >
            <FileEdit size={14} />
          </button>

          {onDeleteClick && (
            <button
              onClick={e => {
                e.stopPropagation()
                onDeleteClick(requirement)
              }}
              className="p-1.5 rounded hover:bg-status-danger/10 text-text-secondary hover:text-status-danger transition-all"
              title={t('card.delete')}
              aria-label={t('card.delete')}
              disabled={disabled}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
