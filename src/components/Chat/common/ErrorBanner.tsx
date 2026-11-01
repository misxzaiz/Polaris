/**
 * ErrorBanner - AI 对话错误提示条
 *
 * 显示错误信息，支持关闭和重试
 */

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X, RotateCcw } from 'lucide-react'
import { useWorkspaceStore } from '@/stores'
import type { Attachment } from '@/types/attachment'
import {
  useActiveSessionActions,
  useActiveSessionMessages,
} from '@/stores/conversationStore/useActiveSession'
import { isUserMessage, type UserChatMessage } from '@/types/chat'

/**
 * 存储态附件 → sendMessage 入参（Attachment）的无损映射。
 *
 * 根因：重试此前只回传 content，attachments 被丢弃——带图消息发送失败后点重试，
 * 附件从新一轮消息中静默消失（UserBubble 不再渲染附件条）。
 * 存储态 UserChatMessage.attachments（types/chat.ts）只保留展示元数据
 * （id/type/fileName/fileSize/mimeType），不含 content(base64)/textContent/preview；
 * 而 sendMessage 入参类型为完整 Attachment（types/attachment.ts:20）。
 * 因此这里只回传存储态真实拥有的字段：
 * - 缺失的二进制内容不伪造：空 content 附件到后端 process_attachments 会被
 *   warn+continue 跳过（src-tauri ai_chat_core.rs:262-268 图片 / 417-422 文件），不会崩；
 * - source/status 是 Attachment 类型必填、但 sendMessage 的两处消费（userMessage
 *   展示映射与 attachmentsForBackend 后端载荷映射）都不读取，仅前端输入溯源用，
 *   以中性值补齐满足类型；
 * - 单条形状异常（历史/异构数据）跳过该条而非硬转，绝不崩掉重试路径。
 */
function mapStoredAttachmentsForRetry(
  stored: UserChatMessage['attachments']
): Attachment[] | undefined {
  if (!stored || stored.length === 0) return undefined
  const mapped: Attachment[] = []
  for (const att of stored) {
    if (!att || typeof att !== 'object') continue
    if (att.type !== 'image' && att.type !== 'file') continue
    if (typeof att.id !== 'string' || typeof att.fileName !== 'string') continue
    mapped.push({
      id: att.id,
      type: att.type,
      source: 'select',
      fileName: att.fileName,
      fileSize: typeof att.fileSize === 'number' ? att.fileSize : 0,
      mimeType: typeof att.mimeType === 'string' ? att.mimeType : 'application/octet-stream',
      content: '',
      status: 'ready',
    })
  }
  return mapped.length > 0 ? mapped : undefined
}

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
    // 根因修复：重试回传附件元数据（映射规则见 mapStoredAttachmentsForRetry 注释），
    // 新一轮消息的附件条不再静默消失。
    sendMessage(
      lastUserMessage.content,
      currentWorkspace?.path,
      mapStoredAttachmentsForRetry(lastUserMessage.attachments)
    )
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
