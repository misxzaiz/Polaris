/**
 * PendingQueueCard - 待发送队列胶囊
 *
 * 流式回复期间的预输入 / 多行拆分的入队项，以胶囊形式挂在输入框上方。
 * 折叠态只占一行（计数徽标 + 清空）；展开可逐条查看、取消。
 * 队列由 ConversationStore.pendingQueue 持有，session_end / 中断后自动逐条发送。
 */

import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListTodo, ChevronDown, X, Trash2 } from 'lucide-react'
import { clsx } from 'clsx'
import {
  useActiveSessionPendingQueue,
  useActiveSessionActions,
} from '@/stores/conversationStore/useActiveSession'

export const PendingQueueCard = memo(function PendingQueueCard() {
  const { t } = useTranslation('chat')
  const pendingQueue = useActiveSessionPendingQueue()
  const { removePending, clearPendingQueue } = useActiveSessionActions()
  const [expanded, setExpanded] = useState(false)

  if (pendingQueue.length === 0) return null

  return (
    <div className="mx-3 mt-2 rounded-lg border border-warning/30 bg-warning/5 overflow-hidden">
      {/* 头行：图标 + 标题 + 计数 + 操作 */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <ListTodo size={13} className="text-warning shrink-0" />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 min-w-0 flex-1 text-left"
          title={t('input.queuedHint')}
        >
          <span className="text-xs font-medium text-text-primary truncate">
            {t('input.pendingQueue')}
          </span>
          <span className="text-[10px] text-text-tertiary shrink-0 tabular-nums">
            {t('input.pendingCount', { n: pendingQueue.length })}
          </span>
          <ChevronDown
            size={12}
            className={clsx('opacity-50 shrink-0 transition-transform', expanded && 'rotate-180')}
          />
        </button>

        <button
          type="button"
          onClick={clearPendingQueue}
          className="p-1 rounded text-text-tertiary hover:text-danger hover:bg-background-hover shrink-0"
          title={t('input.clearQueue')}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* 展开体：逐条查看 / 取消 */}
      {expanded && (
        <div className="px-2 pb-2 max-h-[220px] overflow-y-auto flex flex-col gap-1">
          {pendingQueue.map((msg, i) => (
            <div
              key={msg.id}
              className="flex items-center gap-2 rounded-md border border-border-subtle bg-background-surface/60 px-2 py-1.5"
            >
              <span className="text-[10px] text-text-tertiary tabular-nums shrink-0 w-5 text-right">
                {i + 1}
              </span>
              <span className="flex-1 min-w-0 text-xs text-text-secondary truncate" title={msg.text}>
                {msg.text}
              </span>
              {msg.attachments && msg.attachments.length > 0 && (
                <span className="text-[10px] text-text-tertiary shrink-0">
                  {t('input.attachmentCount', { count: msg.attachments.length })}
                </span>
              )}
              <button
                type="button"
                onClick={() => removePending(msg.id)}
                className="p-0.5 rounded text-text-tertiary hover:text-danger hover:bg-background-hover shrink-0"
                title={t('input.removePending')}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

export default PendingQueueCard
