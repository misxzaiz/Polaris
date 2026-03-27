/**
 * RequirementDetailDialog - 需求详情/编辑弹窗
 *
 * 参考 TodoDetailDialog 模式：open + onClose props，覆盖层点击不关闭
 * 支持三种模式：查看详情、编辑、创建（创建由父组件用 RequirementForm 直接实现）
 * 包含：基本信息展示、审核操作、原型预览、删除
 */

import { useState, useEffect, useCallback } from 'react'
import {
  X,
  Trash2,
  Check,
  XCircle,
  FileEdit,
  Eye,
  Sparkles,
  User,
  Clock,
  Loader2,
  ExternalLink,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Requirement, RequirementPriority, RequirementSource } from '@/types/requirement'
import { RequirementForm } from './RequirementForm'
import { STATUS_STYLES, PRIORITY_TEXT, formatTime, TIME_FORMAT_FULL } from './constants'
import { createLogger } from '@/utils/logger'

const log = createLogger('RequirementDetailDialog')

interface RequirementDetailDialogProps {
  requirement: Requirement
  open: boolean
  disabled?: boolean
  onClose: () => void
  onDelete?: () => void
  onApprove?: (req: Requirement) => void
  onReject?: (req: Requirement, reason?: string) => void
  /** 编辑提交回调 */
  onEditSubmit?: (data: {
    title: string
    description: string
    priority: RequirementPriority
    tags: string[]
    hasPrototype: boolean
    generatedBy: RequirementSource
  }) => void
  /** 读取原型 HTML 内容 */
  onReadPrototype?: (path: string) => Promise<string>
  /** 获取原型文件绝对路径并打开 */
  onOpenPrototype?: (path: string) => Promise<void>
}

export function RequirementDetailDialog({
  requirement,
  open,
  disabled,
  onClose,
  onDelete,
  onApprove,
  onReject,
  onEditSubmit,
  onReadPrototype,
  onOpenPrototype,
}: RequirementDetailDialogProps) {
  const { t, i18n } = useTranslation('requirement')
  const [editing, setEditing] = useState(false)
  const [prototypeHtml, setPrototypeHtml] = useState<string | null>(null)
  const [loadingPrototype, setLoadingPrototype] = useState(false)
  const [prototypeError, setPrototypeError] = useState<string | null>(null)
  const [showRejectInput, setShowRejectInput] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  if (!open) return null

  const style = STATUS_STYLES[requirement.status]
  const canReview = requirement.status === 'pending' || requirement.status === 'draft'

  // 加载原型
  const loadPrototype = useCallback(async () => {
    if (!requirement.hasPrototype || !requirement.prototypePath || !onReadPrototype) return
    setLoadingPrototype(true)
    setPrototypeError(null)
    try {
      const html = await onReadPrototype(requirement.prototypePath)
      setPrototypeHtml(html)
    } catch (e) {
      setPrototypeError(e instanceof Error ? e.message : t('detail.noPrototype'))
    } finally {
      setLoadingPrototype(false)
    }
  }, [requirement.hasPrototype, requirement.prototypePath, onReadPrototype, t])

  useEffect(() => {
    if (open && requirement.hasPrototype) {
      setPrototypeHtml(null)
      loadPrototype()
    }
  }, [open, requirement.hasPrototype, requirement.id, requirement.prototypePath, loadPrototype])

  // Escape 键关闭弹窗
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showRejectInput) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, showRejectInput])

  // 编辑模式：直接用 RequirementForm
  if (editing) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('detail.editTitle')}
        className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      >
        <RequirementForm
          requirement={requirement}
          mode="edit"
          onSubmit={async (data) => {
            setEditing(false)
            onEditSubmit?.(data)
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }

  // 查看模式
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('detail.title')}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    >
      <div
        className="bg-background-elevated rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-medium text-text-primary">
              {t('detail.title')}
            </h2>
            <span className={`px-2 py-0.5 text-xs rounded ${style.bg} ${style.text}`}>
              {t(`status.${requirement.status}`)}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-background-hover text-text-secondary hover:text-text-primary transition-all"
            title={t('form.closeTooltip')}
            aria-label={t('form.closeTooltip')}
          >
            <X size={18} />
          </button>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {/* 标题 */}
          <div>
            <h3 className="text-lg font-semibold text-text-primary break-words">
              {requirement.title || t('form.titlePlaceholder')}
            </h3>
          </div>

          {/* 描述 */}
          {requirement.description && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">
                {t('detail.descriptionField')}
              </label>
              <p className="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
                {requirement.description}
              </p>
            </div>
          )}

          {/* 元信息行 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-text-secondary">
            {/* 优先级 */}
            <div className="flex items-center gap-1">
              <span>{t('detail.priorityField')}:</span>
              <span className={PRIORITY_TEXT[requirement.priority]}>
                {t(`priority.${requirement.priority}`)}
              </span>
            </div>

            {/* 来源 */}
            <div className="flex items-center gap-1">
              {requirement.generatedBy === 'ai' ? (
                <><Sparkles size={12} className="text-purple-500" /> {t('source.ai')}</>
              ) : (
                <><User size={12} /> {t('source.user')}</>
              )}
            </div>

            {/* 原型标识 */}
            {requirement.hasPrototype && (
              <div className="flex items-center gap-1 text-cyan-500">
                <Eye size={12} />
                {t('card.prototype')}
              </div>
            )}
          </div>

          {/* 标签 */}
          {requirement.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {requirement.tags.map(tag => (
                <span
                  key={tag}
                  className="px-2 py-0.5 text-xs text-text-tertiary bg-background-tertiary rounded"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* 审核信息（pending/approved/rejected 状态显示） */}
          {requirement.status !== 'draft' && (
            <div className="p-3 rounded-lg bg-background-surface border border-border-subtle space-y-2">
              <label className="block text-xs font-medium text-text-secondary">
                {t('detail.basicInfo')}
              </label>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="text-text-secondary">
                  {t('detail.generatedAt')}: {formatTime(requirement.generatedAt, i18n.language, TIME_FORMAT_FULL)}
                </div>

                {requirement.reviewedAt && (
                  <div className="text-text-secondary">
                    {t('detail.reviewedAt')}: {formatTime(requirement.reviewedAt, i18n.language, TIME_FORMAT_FULL)}
                  </div>
                )}

                {requirement.executedAt && (
                  <div className="text-text-secondary">
                    <Clock size={12} className="inline mr-0.5" />
                    {t('detail.executedAt')}: {formatTime(requirement.executedAt, i18n.language, TIME_FORMAT_FULL)}
                  </div>
                )}

                {requirement.completedAt && (
                  <div className="text-text-secondary">
                    {t('detail.completedAt')}: {formatTime(requirement.completedAt, i18n.language, TIME_FORMAT_FULL)}
                  </div>
                )}
              </div>

              {requirement.reviewNote && (
                <div className="text-xs text-text-secondary mt-1">
                  {t('detail.reviewNote')}: {requirement.reviewNote}
                </div>
              )}

              {requirement.executeError && (
                <div className="text-xs text-red-400 mt-1">
                  {t('detail.executeError')}: {requirement.executeError}
                </div>
              )}

              {requirement.executeLog && (
                <div className="mt-2">
                  <label className="block text-xs text-text-secondary mb-1">{t('detail.executeLog')}</label>
                  <pre className="text-xs text-text-secondary bg-background-elevated p-2 rounded overflow-x-auto max-h-32 overflow-y-auto">
                    {requirement.executeLog}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* 原型预览 */}
          {requirement.hasPrototype && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-text-secondary">
                  {t('detail.prototype')}
                </label>
                <div className="flex items-center gap-2">
                  {prototypeHtml && (
                    <button
                      onClick={async () => {
                        // 优先使用 onOpenPrototype 打开原型文件
                        if (onOpenPrototype && requirement.prototypePath) {
                          try {
                            await onOpenPrototype(requirement.prototypePath)
                          } catch (e) {
                            log.error('打开原型文件失败:', e instanceof Error ? e : new Error(String(e)))
                          }
                        }
                      }}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary hover:bg-background-hover rounded transition-all"
                      title={t('detail.prototypeNewTab')}
                      aria-label={t('detail.prototypeNewTab')}
                    >
                      <ExternalLink size={12} />
                      {t('detail.prototypeNewTab')}
                    </button>
                  )}
                </div>
              </div>
              {loadingPrototype ? (
                <div className="flex items-center justify-center py-8 text-text-tertiary">
                  <Loader2 size={20} className="animate-spin mr-2" />
                  <span className="text-sm">{t('loading')}</span>
                </div>
              ) : prototypeError ? (
                <div className="p-3 text-xs text-red-400 bg-red-400/10 rounded-lg">
                  {prototypeError}
                </div>
              ) : prototypeHtml ? (
                <div className="border border-border rounded-lg overflow-hidden bg-white">
                  <iframe
                    srcDoc={prototypeHtml}
                    className="w-full h-96 border-0"
                    title={t('detail.prototype')}
                    sandbox="allow-scripts"
                  />
                </div>
              ) : (
                <p className="text-sm text-text-tertiary">{t('detail.noPrototype')}</p>
              )}
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="px-4 py-3 border-t border-border flex items-center justify-between">
          {/* 左侧：审核 + 编辑 */}
          <div className="flex items-center gap-2">
            {canReview && onApprove && (
              <button
                onClick={() => onApprove(requirement)}
                className="px-3 py-1.5 text-sm bg-green-500/10 text-green-500 rounded-lg hover:bg-green-500/20 transition-all flex items-center gap-1 disabled:opacity-50 disabled:pointer-events-none"
                disabled={disabled}
              >
                <Check size={14} />
                {t('detail.actions.approve')}
              </button>
            )}
            {canReview && onReject && !showRejectInput && (
              <button
                onClick={() => setShowRejectInput(true)}
                className="px-3 py-1.5 text-sm bg-red-500/10 text-red-500 rounded-lg hover:bg-red-500/20 transition-all flex items-center gap-1 disabled:opacity-50 disabled:pointer-events-none"
                disabled={disabled}
              >
                <XCircle size={14} />
                {t('detail.actions.reject')}
              </button>
            )}
            {showRejectInput && (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={rejectReason}
                  onChange={e => setRejectReason(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Escape') {
                      setShowRejectInput(false)
                      setRejectReason('')
                    }
                    if (e.key === 'Enter') {
                      onReject!(requirement, rejectReason || undefined)
                      setShowRejectInput(false)
                      setRejectReason('')
                    }
                  }}
                  placeholder={t('detail.actions.rejectPlaceholder')}
                  className="w-40 px-2 py-1 text-xs bg-background-surface border border-border rounded focus:outline-none focus:ring-1 focus:ring-red-500/50 text-text-primary placeholder-text-tertiary"
                  autoFocus
                />
                <button
                  onClick={() => {
                    onReject!(requirement, rejectReason || undefined)
                    setShowRejectInput(false)
                    setRejectReason('')
                  }}
                  className="px-2 py-1 text-xs bg-red-500 text-white rounded hover:bg-red-500/90 transition-all"
                >
                  {t('detail.actions.reject')}
                </button>
                <button
                  onClick={() => { setShowRejectInput(false); setRejectReason('') }}
                  className="p-1 text-text-tertiary hover:text-text-secondary transition-all"
                >
                  <X size={14} />
                </button>
              </div>
            )}
            <button
              onClick={() => setEditing(true)}
              className="px-3 py-1.5 text-sm bg-background-surface border border-border rounded-lg hover:bg-background-hover text-text-secondary hover:text-text-primary transition-all flex items-center gap-1 disabled:opacity-50 disabled:pointer-events-none"
              disabled={disabled}
            >
              <FileEdit size={14} />
              {t('card.edit')}
            </button>
          </div>

          {/* 右侧：删除 */}
          {onDelete && (
            <button
              onClick={() => {
                onDelete()
                onClose()
              }}
              className="px-3 py-1.5 text-sm text-red-500 rounded-lg hover:bg-red-500/10 transition-all flex items-center gap-1 disabled:opacity-50 disabled:pointer-events-none"
              disabled={disabled}
            >
              <Trash2 size={14} />
              {t('detail.actions.delete')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
