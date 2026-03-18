/**
 * CompactMode - 小屏对话模式组件
 *
 * 当窗口宽度小于阈值时，切换到精简的对话界面：
 * - 极简顶部：仅引擎选择器
 * - 全屏对话消息区域
 * - 底部固定输入框
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigStore, useEventChatStore, useWorkspaceStore } from '../../stores'
import { EnhancedChatMessages } from '../Chat'
import { CompactChatInput } from './CompactChatInput'
import type { EngineId } from '../../types'
import type { Attachment } from '../../types/attachment'
import type { CommandOptionValue } from '../../types/engineCommand'

interface CompactModeProps {
  onSend: (message: string, workspaceDir?: string, attachments?: Attachment[], engineOptions?: CommandOptionValue[]) => void
  onInterrupt: () => void
  disabled?: boolean
  isStreaming?: boolean
}

export function CompactMode({ onSend, onInterrupt, disabled, isStreaming }: CompactModeProps) {
  const { t } = useTranslation('common')
  const { config, updateConfig } = useConfigStore()
  const { error } = useEventChatStore()
  const currentWorkspace = useWorkspaceStore(state => state.getCurrentWorkspace())

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

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 极简顶部 - 仅引擎选择器 */}
      <div className="flex items-center justify-between px-3 py-2 bg-background-elevated border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-primary">{t('labels.aiChat')}</span>
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

        {/* 工作区名称 */}
        {currentWorkspace && (
          <span className="text-xs text-text-tertiary truncate max-w-[120px]">
            {currentWorkspace.name}
          </span>
        )}
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mx-3 mt-3 p-2 bg-danger-faint border border-danger/30 rounded-lg text-danger text-xs shrink-0">
          {error}
        </div>
      )}

      {/* 对话消息区域 - 占据剩余空间 */}
      <div className="flex-1 overflow-hidden">
        <EnhancedChatMessages />
      </div>

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
