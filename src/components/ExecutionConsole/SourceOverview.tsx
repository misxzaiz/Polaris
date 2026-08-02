/**
 * 触发源总览 - 控制台第一区
 *
 * 按来源分组展示数量与健康状态：
 * - 聊天会话：总数 / 运行中
 * - 定时任务：启用数 / 执行中
 * - 机器人集成：各平台连接状态 / 处理中
 */

import { useTranslation } from 'react-i18next'
import { MessageSquare, Clock, Bot } from 'lucide-react'
import { useSessionMetadataList } from '@/stores/conversationStore/sessionStoreManager'
import { useSchedulerStore } from '@/stores/schedulerStore'
import { useIntegrationStore } from '@/stores/integrationStore'
import { useExecutionConsoleStore, selectActiveIntegrationRuns } from '@/stores/executionConsoleStore'
import { useViewStore } from '@/stores/viewStore'
import type { Platform } from '@/types'
import { ConnectionStateColors } from '@/types/integration'

interface SourceCardProps {
  icon: React.ReactNode
  title: string
  detail: React.ReactNode
  runningCount: number
  onClick?: () => void
}

function SourceCard({ icon, title, detail, runningCount, onClick }: SourceCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-background-base border border-border hover:border-border-strong transition-colors text-left"
    >
      <div className="shrink-0 text-text-tertiary">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-text-primary truncate">{title}</div>
        <div className="text-[11px] text-text-tertiary truncate">{detail}</div>
      </div>
      {runningCount > 0 && (
        <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-success/15 text-success text-[10px] font-bold flex items-center justify-center">
          {runningCount}
        </span>
      )}
    </button>
  )
}

export function SourceOverview() {
  const { t } = useTranslation('executionConsole')
  const sessions = useSessionMetadataList()
  const tasks = useSchedulerStore((s) => s.tasks)
  const runningTaskIds = useSchedulerStore((s) => s.runningTaskIds)
  const platforms = useIntegrationStore((s) => s.platforms)
  const activeIntegrationRuns = useExecutionConsoleStore(selectActiveIntegrationRuns)
  const setLeftPanelType = useViewStore((s) => s.setLeftPanelType)

  // 聊天会话统计（排除静默会话）
  const visibleSessions = sessions.filter((s) => !s.silentMode)
  const runningChatCount = visibleSessions.filter(
    (s) => s.status === 'running' || s.status === 'background-running' || s.status === 'waiting'
  ).length

  // 定时任务统计
  const enabledTaskCount = tasks.filter((task) => task.enabled).length

  // 集成平台状态
  const platformEntries = Object.entries(platforms) as Array<[Platform, typeof platforms[Platform]]>
  const connectedCount = platformEntries.filter(([, status]) => status?.connected).length

  return (
    <div className="flex flex-col gap-1.5 px-2 pt-2">
      <SourceCard
        icon={<MessageSquare size={16} />}
        title={t('source.chat')}
        detail={t('source.chatDetail', { total: visibleSessions.length, running: runningChatCount })}
        runningCount={runningChatCount}
      />
      <SourceCard
        icon={<Clock size={16} />}
        title={t('source.scheduler')}
        detail={t('source.schedulerDetail', { enabled: enabledTaskCount, running: runningTaskIds.size })}
        runningCount={runningTaskIds.size}
        onClick={() => setLeftPanelType('scheduler')}
      />
      <SourceCard
        icon={<Bot size={16} />}
        title={t('source.integration')}
        detail={
          platformEntries.length === 0 ? (
            t('source.integrationNone')
          ) : (
            <span className="flex items-center gap-2">
              {platformEntries.map(([platform, status]) => (
                <span key={platform} className="flex items-center gap-1">
                  <span className={status ? ConnectionStateColors[status.connectionState] : 'text-text-tertiary'}>●</span>
                  {t(`platform.${platform}`, { defaultValue: platform })}
                </span>
              ))}
            </span>
          )
        }
        runningCount={activeIntegrationRuns.length}
        onClick={() => setLeftPanelType('integration')}
      />
      {/* 已连接平台计数仅用于无障碍/调试，不额外展示 */}
      <span className="sr-only">{t('source.connectedCount', { count: connectedCount })}</span>
    </div>
  )
}
