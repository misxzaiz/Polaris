/**
 * CompactMode - 小屏对话模式组件
 *
 * 当窗口宽度小于阈值时，切换到精简的对话界面：
 * - 极简顶部：仅引擎选择器
 * - 全屏对话消息区域
 * - 底部固定输入框
 * - 消息导航功能
 */

import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Clock } from 'lucide-react'
import { useConfigStore, useEventChatStore, useWorkspaceStore, useViewStore } from '../../stores'
import { CompactMessageList, type CompactMessageListRef } from './CompactMessageList'
import { CompactChatInput } from './CompactChatInput'
import { CompactChatNavigator } from './CompactChatNavigator'
import type { EngineId } from '../../types'
import type { Attachment } from '../../types/attachment'

interface CompactModeProps {
  onSend: (message: string, workspaceDir?: string, attachments?: Attachment[]) => void
  onInterrupt: () => void
  disabled?: boolean
  isStreaming?: boolean
}

export function CompactMode({ onSend, onInterrupt, disabled, isStreaming }: CompactModeProps) {
  const { t } = useTranslation('common')
  const { config, updateConfig } = useConfigStore()
  const { error, clearMessages, messages } = useEventChatStore()
  const currentWorkspace = useWorkspaceStore(state => state.getCurrentWorkspace())
  const { toggleSessionHistory } = useViewStore()
  const messageListRef = useRef<CompactMessageListRef>(null)

  // 引擎选项列表
  const engineOptions = useMemo(() => {
    const options: { id: EngineId; name: string }[] = [
      { id: 'claude-code', name: 'Claude Code' },
      { id: 'iflow', name: 'IFlow' },
      { id: 'codex', name: 'Codex' },
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

  // 引擎切换
  const handleEngineChange = async (engineId: EngineId) => {
    if (!config || engineId === config.defaultEngine) return

    const isProvider = engineId.startsWith('provider-')
    const nextConfig = {
      ...config,
      defaultEngine: engineId,
      activeProviderId: isProvider ? engineId : config.activeProviderId,
    }
    await updateConfig(nextConfig)
  }

  // 新对话
  const handleNewChat = () => {
    if (messages.length > 0) {
      clearMessages()
    }
  }

  // 滚动到指定消息
  const handleScrollToMessage = (index: number) => {
    messageListRef.current?.scrollToMessage(index)
  }

  // 滚动到底部
  const handleScrollToBottom = () => {
    messageListRef.current?.scrollToBottom()
  }

  return (
    <div className="flex flex-col h-full bg-background compact-mode-transition">
      {/* 极简顶部 - 引擎选择器 + 快捷操作 */}
      <div className="flex items-center justify-between px-2 py-1.5 bg-background-elevated border-b border-border shrink-0">
        {/* 左侧：引擎选择 */}
        <div className="flex items-center gap-2">
          <select
            className="bg-background-surface border border-border text-text-primary text-xs px-2 py-1 rounded-md hover:border-primary/50 transition-colors cursor-pointer"
            value={config?.defaultEngine || 'claude-code'}
            onChange={(e) => handleEngineChange(e.target.value as EngineId)}
            disabled={isStreaming}
          >
            {engineOptions.map((opt) => (
              <option key={opt.id} value={opt.id} className="bg-background text-text-primary">{opt.name}</option>
            ))}
          </select>
        </div>

        {/* 右侧：导航 + 快捷操作 */}
        <div className="flex items-center gap-1">
          {/* 消息导航 */}
          {messages.length > 1 && (
            <CompactChatNavigator
              onScrollToMessage={handleScrollToMessage}
              onScrollToBottom={handleScrollToBottom}
            />
          )}

          {/* 新对话 */}
          <button
            onClick={handleNewChat}
            disabled={isStreaming}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors disabled:opacity-50"
            title={t('menu.newChat')}
          >
            <Plus className="w-4 h-4" />
          </button>

          {/* 会话历史 */}
          <button
            onClick={toggleSessionHistory}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
            title={t('menu.sessionHistory')}
          >
            <Clock className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mx-2 mt-2 p-2 bg-danger-faint border border-danger/30 rounded-lg text-danger text-xs shrink-0">
          {error}
        </div>
      )}

      {/* 对话消息区域 - 占据剩余空间 */}
      <CompactMessageList ref={messageListRef} />

      {/* 底部固定输入框 */}
      <CompactChatInput
        onSend={onSend}
        onInterrupt={onInterrupt}
        disabled={disabled || !currentWorkspace}
        isStreaming={isStreaming}
      />
    </div>
  )
}
