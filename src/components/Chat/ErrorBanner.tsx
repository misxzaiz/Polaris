/**
 * ErrorBanner - AI 对话错误提示条
 *
 * 显示错误信息，支持关闭和重试
 */

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X, RotateCcw } from 'lucide-react'
import { useWorkspaceStore } from '@/stores'
import {
  useActiveSessionActions,
  useActiveSessionMessages,
} from '@/stores/conversationStore/useActiveSession'
import { isUserMessage, type UserChatMessage } from '@/types/chat'

export function ErrorBanner({ error }: { error: string }) {
  const { t } = useTranslation(['errors', 'common'])
  const { sendMessage, clearError } = useActiveSessionActions()
  const { messages } = useActiveSessionMessages()
  const currentWorkspace = useWorkspaceStore(
    state => state.workspaces.find(w => w.id === state.currentWorkspaceId) || null
  )

  // i18n key 格式: "errors:appError.network" → t('appError.network', { ns: 'errors' })
  // 非 key 格式（如 User 类型错误的原文）直接显示
  const displayError = error.startsWith('errors:') ? t(error.slice(7), { ns: 'errors' }) : error

  // 找到最后一条用户消息，用于重试
  const lastUserMessage = useMemo((): UserChatMessage | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (isUserMessage(msg)) {
        return msg
      }
    }
    return null
  }, [messages])

  const handleDismiss = useCallback(() => {
    clearError()
  }, [clearError])

  const handleRetry = useCallback(() => {
    if (!lastUserMessage) return
    clearError()
    sendMessage(lastUserMessage.content, currentWorkspace?.path)
  }, [lastUserMessage, currentWorkspace, clearError, sendMessage])

  return (
    <div className="mx-4 mt-4 p-3 bg-danger-faint border border-danger/30 rounded-xl text-danger text-sm shrink-0 flex items-start gap-2">
      <div className="flex-1 min-w-0 break-words">{displayError}</div>
      <div className="flex items-center gap-1 shrink-0">
        {lastUserMessage && (
          <button
            onClick={handleRetry}
            className="p-1 text-danger/70 hover:text-danger hover:bg-danger/10 rounded transition-colors"
            title={t('retry')}
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={handleDismiss}
          className="p-1 text-danger/70 hover:text-danger hover:bg-danger/10 rounded transition-colors"
          title={t('close')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
