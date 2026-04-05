/**
 * AIPopover - AI 对话弹出面板
 *
 * 一个可从多个位置打开的 AI 对话弹出窗口
 */

import { useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { EnhancedChatMessages, ChatInput } from '../Chat'
import { useConfigStore, useEventChatStore, useWorkspaceStore } from '../../stores'
import { useActiveSessionActions } from '../../stores/conversationStore/useActiveSession'
import type { EngineId } from '../../types'

interface AIPopoverProps {
  isOpen: boolean
  onClose: () => void
}

export function AIPopover({ isOpen, onClose }: AIPopoverProps) {
  const { t } = useTranslation('common')
  const { config, updateConfig } = useConfigStore()
  const {
    isStreaming,
    error,
    clearMessages,
  } = useEventChatStore()
  // 使用新架构的 sendMessage 和 interrupt
  const { sendMessage, interrupt: interruptChat } = useActiveSessionActions()
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
  const engineOptions = useMemo(() => {
    const options: { id: EngineId; name: string }[] = [
      { id: 'claude-code', name: 'Claude Code' },
    ]

    if (config?.openaiProviders && config.openaiProviders.length > 0) {
      for (const provider of config.openaiProviders) {
        if (!provider.enabled) continue
        options.push({
          id: provider.id as EngineId,
          name: provider.name || provider.id,
        })
      }
    }

    return options
  }, [config?.openaiProviders])

  const handleEngineSelect = useCallback(async (engineId: EngineId) => {
    if (!config) return
    if (engineId === config.defaultEngine) return

    if (isStreaming) {
      try {
        await interruptChat()
      } catch (e) {
        console.warn('[AIPopover] 中断失败，继续切换引擎:', e)
      }
    }

    clearMessages()

    const isProvider = engineId.startsWith('provider-')
    const nextConfig = {
      ...config,
      defaultEngine: engineId,
      activeProviderId: isProvider ? engineId : config.activeProviderId,
    }
    await updateConfig(nextConfig)
  }, [config, isStreaming, interruptChat, clearMessages, updateConfig])

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
                className="bg-background-elevated border border-border-subtle text-text-primary text-xs px-2 py-1 rounded-md"
                value={config?.defaultEngine || 'claude-code'}
                onChange={(e) => handleEngineSelect(e.target.value as EngineId)}
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
          {error && (
            <div className="mx-4 mt-4 p-3 bg-danger-faint border border-danger/30 rounded-xl text-danger text-sm shrink-0">
              {error}
            </div>
          )}

          {/* 消息区域 */}
          <EnhancedChatMessages />

          {/* 输入区域 */}
          <ChatInput
            onSend={sendMessage}
            onInterrupt={interruptChat}
            disabled={!currentWorkspace}
            isStreaming={isStreaming}
          />
        </div>
      </div>
    </>
  )
}
