/**
 * RequirementGenerateDialog - AI 生成需求对话框
 *
 * 选择分析范围和补充上下文后触发 req-generate 协议任务
 */

import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface RequirementGenerateDialogProps {
  open: boolean
  onConfirm: (scope: string, context: string) => void
  onCancel: () => void
}

export function RequirementGenerateDialog({
  open,
  onConfirm,
  onCancel,
}: RequirementGenerateDialogProps) {
  const { t } = useTranslation('requirement')
  const [scope, setScope] = useState('all')
  const [context, setContext] = useState('')

  useEffect(() => {
    if (open) {
      setScope('all')
      setContext('')
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onCancel])

  if (!open) return null

  const handleConfirm = () => {
    onConfirm(scope, context.trim())
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('generate.title')}
      className="fixed inset-0 bg-overlay flex items-center justify-center z-50"
    >
      <div
        className="bg-background-elevated rounded-lg shadow-xl w-full max-w-md"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-base font-medium text-text-primary">
            {t('generate.title')}
          </h2>
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-background-hover text-text-secondary hover:text-text-primary transition-all"
            aria-label={t('generate.cancel')}
          >
            <X size={18} />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-4 py-4 space-y-4">
          {/* 范围选择 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('generate.scope')}
            </label>
            <div className="flex gap-2">
              {(['all', 'frontend', 'backend'] as const).map(option => (
                <button
                  key={option}
                  onClick={() => setScope(option)}
                  className={`px-3 py-1.5 text-xs rounded-lg transition-all ${
                    scope === option
                      ? 'bg-primary text-on-primary'
                      : 'bg-background-surface border border-border text-text-secondary hover:bg-background-hover'
                  }`}
                >
                  {t(`generate.scope${option.charAt(0).toUpperCase() + option.slice(1)}` as 'generate.scopeAll' | 'generate.scopeFrontend' | 'generate.scopeBackend')}
                </button>
              ))}
            </div>
          </div>

          {/* 补充上下文 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('generate.context')}
            </label>
            <textarea
              value={context}
              onChange={e => setContext(e.target.value)}
              placeholder={t('generate.contextPlaceholder')}
              rows={3}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 text-text-primary placeholder-text-tertiary resize-none"
            />
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm bg-background-surface border border-border rounded-lg hover:bg-background-hover text-text-secondary transition-all"
          >
            {t('generate.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            className="px-3 py-1.5 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90 transition-all"
          >
            {t('generate.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
