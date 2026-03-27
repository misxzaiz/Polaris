/**
 * RequirementDetailDialog - 需求详情/编辑弹窗
 *
 * 参考 TodoDetailDialog 模式：open + onClose props，覆盖层点击不关闭
 * 支持三种模式：查看详情、编辑、创建（创建由父组件用 RequirementForm 直接实现）
 * 包含：基本信息展示、审核操作、原型预览、删除
 */

import { useState, useEffect } from 'react'
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
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Requirement, RequirementPriority, RequirementSource } from '@/types/requirement'
import { RequirementForm } from './RequirementForm'

interface RequirementDetailDialogProps {
  requirement: Requirement
  open: boolean
  onClose: () => void
  onDelete?: () => void
  onApprove?: (req: Requirement) => void
  onReject?: (req: Requirement) => void
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
}

/** 状态颜色映射 */
const statusStyleMap: Record<string, { text: string; bg: string }> = {
  draft: { text: 'text-text-tertiary', bg: 'bg-gray-500/10' },
  pending: { text: 'text-amber-500', bg: 'bg-amber-500/10' },
  approved: { text: 'text-green-500', bg: 'bg-green-500/10' },
  rejected: { text: 'text-red-500', bg: 'bg-red-500/10' },
  executing: { text: 'text-blue-500', bg: 'bg-blue-500/10' },
  completed: { text: 'text-indigo-500', bg: 'bg-indigo-500/10' },
  failed: { text: 'text-red-400', bg: 'bg-red-400/10' },
}

export function RequirementDetailDialog({
  requirement,
  open,
  onClose,
  onDelete,
  onApprove,
  onReject,
  onEditSubmit,
  onReadPrototype,
}: RequirementDetailDialogProps) {
  const { t } = useTranslation('requirement')
  const [editing, setEditing] = useState(false)
  const [prototypeHtml, setPrototypeHtml] = useState<string | null>(null)
  const [loadingPrototype, setLoadingPrototype] = useState(false)
  const [prototypeError, setPrototypeError] = useState<string | null>(null)

  if (!open) return null

  const style = statusStyleMap[requirement.status] || statusStyleMap.draft
  const canReview = requirement.status === 'pending'

  // 加载原型
  const loadPrototype = async () => {
    if (!requirement.hasPrototype || !requirement.prototypePath || !onReadPrototype) return
    setLoadingPrototype(true)
    setPrototypeError(null)
    try {
      const html = await onReadPrototype(requirement.prototypePath)
      setPrototypeHtml(html)
    } catch (e) {
      setPrototypeError(e instanceof Error ? e.message : 'Failed to load prototype')
    } finally {
      setLoadingPrototype(false)
    }
  }

  useEffect(() => {
    if (open && requirement.hasPrototype) {
      setPrototypeHtml(null)
      loadPrototype()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, requirement.id])

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleString('zh-CN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  // 编辑模式：直接用 RequirementForm
  if (editing) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
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
              <span className={statusStyleMap[`priority-${requirement.priority}`]
                ? 'text-blue-500'
                : ''}>
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
                  {t('detail.generatedAt')}: {formatTime(requirement.generatedAt)}
                </div>

                {requirement.reviewedAt && (
                  <div className="text-text-secondary">
                    {t('detail.reviewedAt')}: {formatTime(requirement.reviewedAt)}
                  </div>
                )}

                {requirement.executedAt && (
                  <div className="text-text-secondary">
                    <Clock size={12} className="inline mr-0.5" />
                    执行开始: {formatTime(requirement.executedAt)}
                  </div>
                )}

                {requirement.completedAt && (
                  <div className="text-text-secondary">
                    完成时间: {formatTime(requirement.completedAt)}
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
                  执行错误: {requirement.executeError}
                </div>
              )}

              {requirement.executeLog && (
                <div className="mt-2">
                  <label className="block text-xs text-text-secondary mb-1">执行日志</label>
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
              <label className="block text-xs font-medium text-text-secondary mb-2">
                {t('detail.prototype')}
              </label>
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
                    className="w-full h-64 border-0"
                    title={`Prototype: ${requirement.title}`}
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
                className="px-3 py-1.5 text-sm bg-green-500/10 text-green-500 rounded-lg hover:bg-green-500/20 transition-all flex items-center gap-1"
              >
                <Check size={14} />
                {t('detail.actions.approve')}
              </button>
            )}
            {canReview && onReject && (
              <button
                onClick={() => onReject(requirement)}
                className="px-3 py-1.5 text-sm bg-red-500/10 text-red-500 rounded-lg hover:bg-red-500/20 transition-all flex items-center gap-1"
              >
                <XCircle size={14} />
                {t('detail.actions.reject')}
              </button>
            )}
            <button
              onClick={() => setEditing(true)}
              className="px-3 py-1.5 text-sm bg-background-surface border border-border rounded-lg hover:bg-background-hover text-text-secondary hover:text-text-primary transition-all flex items-center gap-1"
            >
              <FileEdit size={14} />
              {t('card.edit')}
            </button>
          </div>

          {/* 右侧：删除 */}
          {onDelete && (
            <button
              onClick={() => {
                if (confirm(t('confirm.deleteMessage'))) {
                  onDelete()
                  onClose()
                }
              }}
              className="px-3 py-1.5 text-sm text-red-500 rounded-lg hover:bg-red-500/10 transition-all flex items-center gap-1"
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
