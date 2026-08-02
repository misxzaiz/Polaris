/**
 * Fork 会话对话框组件
 *
 * 用户点击 Fork 后弹出的确认对话框，支持：
 * - 显示源会话信息
 * - 可选输入分支名称
 * - 确认创建分支会话
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch, MessageSquare, Clock, X } from 'lucide-react'
import type { UnifiedHistoryItem } from '@/services/historyService'

interface ForkSessionDialogProps {
  /** 源会话信息 */
  sourceSession: UnifiedHistoryItem
  /** 确认 Fork */
  onConfirm: (branchName?: string) => void
  /** 取消 */
  onCancel: () => void
}

export function ForkSessionDialog({
  sourceSession,
  onConfirm,
  onCancel,
}: ForkSessionDialogProps) {
  const { t } = useTranslation('chat')
  const [branchName, setBranchName] = useState('')

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp)
    return date.toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-background-elevated rounded-xl shadow-2xl border border-border w-[420px] max-w-[90vw]">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-amber-500" />
            <h2 className="text-base font-semibold text-text-primary">
              {t('fork.title')}
            </h2>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-5 py-4 space-y-4">
          {/* 源会话信息 */}
          <div className="p-3 rounded-lg bg-background border border-border-subtle">
            <p className="text-xs text-text-tertiary mb-2">{t('fork.sourceSession')}</p>
            <p className="text-sm font-medium text-text-primary truncate">
              {sourceSession.title}
            </p>
            <div className="flex items-center gap-4 mt-2 text-xs text-text-tertiary">
              <span className="flex items-center gap-1">
                <MessageSquare className="w-3 h-3" />
                {t('fork.messages', { count: sourceSession.messageCount })}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatTime(sourceSession.timestamp)}
              </span>
            </div>
            {sourceSession.gitBranch && (
              <p className="mt-1.5 text-xs text-text-tertiary">
                {t('fork.gitBranch', { branch: sourceSession.gitBranch })}
              </p>
            )}
            {sourceSession.linkedPr && (
              <p className="mt-1 text-xs text-violet-500">
                {t('fork.linkedPr', { number: sourceSession.linkedPr.number })}
              </p>
            )}
          </div>

          {/* 继承说明 */}
          <div className="text-xs text-text-secondary">
            <p>{t('fork.inheritContext')}</p>
            <ul className="mt-1.5 ml-4 space-y-0.5 list-disc">
              <li>{t('fork.historyMessages', { count: sourceSession.messageCount })}</li>
              {sourceSession.gitBranch && <li>{t('fork.gitBranch', { branch: sourceSession.gitBranch })}</li>}
              {sourceSession.linkedPr && <li>{t('fork.prLink', { number: sourceSession.linkedPr.number })}</li>}
            </ul>
          </div>

          {/* 分支名称 */}
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">
              {t('fork.branchName')}
            </label>
            <input
              type="text"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              placeholder={t('fork.branchNamePlaceholder')}
              className="w-full px-3 py-2 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 bg-background"
            />
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-md transition-colors"
          >
            {t('fork.cancel')}
          </button>
          <button
            onClick={() => onConfirm(branchName || undefined)}
            className="px-4 py-2 text-sm font-medium text-white bg-amber-500 hover:bg-amber-600 rounded-md transition-colors"
          >
            {t('fork.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ForkSessionDialog
