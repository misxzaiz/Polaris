/**
 * AIPopover - AI 对话弹出面板
 *
 * 一个可从多个位置打开的 AI 对话弹出窗口
 */

import { useEffect, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { EnhancedChatMessages, ChatInput } from '../Chat'
import type { EditMode } from '../Chat'
import { ErrorBanner } from './ErrorBanner'
import { useConfigStore, useWorkspaceStore } from '@/stores'
import {
  useActiveSessionConversationId,
  useActiveSessionError,
  useActiveSessionActions,
  useActiveSessionMessages,
  useActiveSessionStreaming,
} from '@/stores/conversationStore/useActiveSession'
import {
  useActiveSessionId,
  useSessionManagerActions,
  useSessionMetadataList,
} from '@/stores/conversationStore/sessionStoreManager'
import type { EngineId } from '@/types'
import { createLogger } from '@/utils/logger'
import { normalizeEngineId } from '@/utils/engineDisplay'

const log = createLogger('AIPopover')

interface AIPopoverProps {
  isOpen: boolean
  onClose: () => void
}

export function AIPopover({ isOpen, onClose }: AIPopoverProps) {
  const { t } = useTranslation('common')
  const { config } = useConfigStore()
  const isStreaming = useActiveSessionStreaming()
  const error = useActiveSessionError()
  const { sendMessage, interrupt: interruptChat, editAndResend } = useActiveSessionActions()
  const { updateSessionEngine } = useSessionManagerActions()

  // 编辑模式状态
  const [editMode, setEditMode] = useState<EditMode | null>(null)
  const handleEditMessage = useCallback((messageId: string, content: string) => {
    setEditMode({ messageId, content })
  }, [])
  const handleCancelEdit = useCallback(() => {
    setEditMode(null)
  }, [])
  const handleEditSend = useCallback((messageId: string, newContent: string) => {
    editAndResend(messageId, newContent)
    setEditMode(null)
  }, [editAndResend])
  const activeSessionId = useActiveSessionId()
  const sessionMetadataList = useSessionMetadataList()
  const { messages } = useActiveSessionMessages()
  const conversationId = useActiveSessionConversationId()
  const currentWorkspace = useWorkspaceStore(state => state.getCurrentWorkspace())

  // ESC 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // 引擎选项
  const engineOptions = useMemo(() => [
    { id: 'claude-code' as EngineId, name: 'Claude Code' },
    { id: 'codex' as EngineId, name: 'OpenAI Codex' },
    { id: 'agnes' as EngineId, name: 'Agnes（生图）' },
    { id: 'mimo' as EngineId, name: 'Mimo Code' },
  ], [])

  const activeSessionMetadata = useMemo(
    () => sessionMetadataList.find(session => session.id === activeSessionId),
    [activeSessionId, sessionMetadataList]
  )
  const activeEngineId = normalizeEngineId(activeSessionMetadata?.engineId || config?.defaultEngine)
  const canSwitchEngine = Boolean(activeSessionId) && !isStreaming && !conversationId && messages.length === 0

  const handleEngineSelect = useCallback((engineId: EngineId) => {
    if (!activeSessionId || engineId === activeEngineId) return

    const updated = updateSessionEngine(activeSessionId, engineId)
    if (!updated) {
      log.warn('Engine switch ignored because active session is no longer empty', { activeSessionId, engineId })
    }
  }, [activeEngineId, activeSessionId, updateSessionEngine])

  if (!isOpen) return null

  return (
    <>
      {/* 背景遮罩 */}
      <div
        className="fixed inset-0 bg-black/50 z-50"
        onClick={onClose}
      />

      {/* 弹出面板 */}
      <div className="fixed inset-4 z-50 flex items-center justify-center pointer-events-none sm:inset-8 md:inset-16 lg:inset-24">
        <div
          className="bg-background-elevated border border-border rounded-xl shadow-2xl w-full h-full max-w-4xl max-h-[80vh] flex flex-col pointer-events-auto overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 头部 */}
          <div className="flex items-center justify-between px-4 py-3 bg-background-elevated border-b border-border-subtle shrink-0">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-text-primary">{t('labels.aiChat')}</span>
              <select
                className="bg-background-elevated border border-border-subtle text-text-primary text-xs px-2 py-1 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
                value={activeEngineId}
                onChange={(e) => handleEngineSelect(e.target.value as EngineId)}
                disabled={!canSwitchEngine}
                title={canSwitchEngine ? t('tooltips.engineSwitchEnabled') : t('tooltips.engineSwitchDisabled')}
              >
                {engineOptions.map((opt) => (
                  <option key={opt.id} value={opt.id} className="bg-background text-text-primary">{opt.name}</option>
                ))}
              </select>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 text-text-tertiary hover:text-text-primary transition-colors rounded-lg hover:bg-background-hover"
              title={t('buttons.close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 错误提示 */}
          {error && <ErrorBanner error={error} />}

          {/* 消息区域 */}
          <EnhancedChatMessages onEditMessage={handleEditMessage} />

          {/* 输入区域 */}
          <ChatInput
            onSend={sendMessage}
            onInterrupt={interruptChat}
            disabled={!currentWorkspace}
            isStreaming={isStreaming}
            editMode={editMode}
            onCancelEdit={handleCancelEdit}
            onEditSend={handleEditSend}
          />
        </div>
      </div>
    </>
  )
}
