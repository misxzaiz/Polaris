/**
 * PendingBriefingCard - 待发送简报卡片
 *
 * 压缩交接产物不塞进输入框，而是作为「待发送上下文」挂在输入框上方。
 * 折叠态只占一行；展开可查看/编辑全文；可移除。用户发送自己的消息时，
 * 简报作为一次性系统上下文（oneTimeSystemPrompt）随之带出，不进入用户气泡。
 */

import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, ChevronDown, X, Check, Pencil } from 'lucide-react'
import { clsx } from 'clsx'
import {
  useActiveSessionPendingBriefing,
  useActiveSessionActions,
} from '@/stores/conversationStore/useActiveSession'

export const PendingBriefingCard = memo(function PendingBriefingCard() {
  const { t } = useTranslation('chat')
  const briefing = useActiveSessionPendingBriefing()
  const { setPendingBriefing } = useActiveSessionActions()

  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 简报变化（新一次交接）时重置本地展开/编辑态
  useEffect(() => {
    setExpanded(false)
    setEditing(false)
  }, [briefing])

  useEffect(() => {
    if (editing) {
      setDraft(briefing ?? '')
      setTimeout(() => textareaRef.current?.focus(), 0)
    }
  }, [editing, briefing])

  if (!briefing) return null

  const saveEdit = () => {
    setPendingBriefing(draft.trim() ? draft : null)
    setEditing(false)
  }

  return (
    <div className="mx-3 mt-2 rounded-lg border border-primary/30 bg-primary/5 overflow-hidden">
      {/* 头行：图标 + 标题 + 操作 */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Archive size={13} className="text-primary shrink-0" />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 min-w-0 flex-1 text-left"
          title={expanded ? t('compactHandoff.card.collapse') : t('compactHandoff.card.expand')}
        >
          <span className="text-xs font-medium text-text-primary truncate">
            {t('compactHandoff.card.title')}
          </span>
          <span className="text-[10px] text-text-tertiary shrink-0">
            {t('compactHandoff.card.hint')}
          </span>
          <ChevronDown
            size={12}
            className={clsx('opacity-50 shrink-0 transition-transform', expanded && 'rotate-180')}
          />
        </button>

        {/* 编辑 / 移除 */}
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setExpanded(true)
              setEditing(true)
            }}
            className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-background-hover shrink-0"
            title={t('compactHandoff.card.edit')}
          >
            <Pencil size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={() => setPendingBriefing(null)}
          className="p-1 rounded text-text-tertiary hover:text-danger hover:bg-background-hover shrink-0"
          title={t('compactHandoff.card.remove')}
        >
          <X size={13} />
        </button>
      </div>

      {/* 展开体：只读预览 / 编辑 */}
      {expanded && (
        <div className="px-3 pb-2">
          {editing ? (
            <div className="flex flex-col gap-2">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={12}
                className="w-full px-3 py-2 text-xs bg-background-surface border border-border rounded-lg outline-none focus:border-primary resize-y font-mono leading-relaxed"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary"
                >
                  {t('sessionConfig.cancel')}
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-primary text-white hover:bg-primary-hover"
                >
                  <Check size={12} />
                  {t('compactHandoff.card.save')}
                </button>
              </div>
            </div>
          ) : (
            <div className="max-h-[200px] overflow-y-auto text-xs text-text-secondary whitespace-pre-wrap font-mono leading-relaxed bg-background-surface/60 rounded-lg p-2 border border-border-subtle">
              {briefing}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

export default PendingBriefingCard
