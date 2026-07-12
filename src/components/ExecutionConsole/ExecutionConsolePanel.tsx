/**
 * AI 执行控制台面板
 *
 * 统一观测所有 AI 触发源的实时执行情况：
 * - 触发源总览：聊天会话 / 定时任务 / 机器人集成的数量与健康状态
 * - 实时执行：所有来源"正在运行"的统一列表
 * - 执行历史：已结束执行的时间线
 *
 * 纯只读观测层，不参与任何执行链路（不监听 scheduler-task-due，
 * 零双重触发风险）。
 */

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity } from 'lucide-react'
import { useExecutionConsoleStore } from '@/stores/executionConsoleStore'
import { useSchedulerStore } from '@/stores/schedulerStore'
import { useIntegrationStore } from '@/stores/integrationStore'
import { SourceOverview } from './SourceOverview'
import { ActiveExecutionList } from './ActiveExecutionList'
import { ExecutionHistoryList } from './ExecutionHistoryList'

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary select-none">
      {title}
    </div>
  )
}

export function ExecutionConsolePanel() {
  const { t } = useTranslation('executionConsole')
  const initialize = useExecutionConsoleStore((s) => s.initialize)
  const loadTasks = useSchedulerStore((s) => s.loadTasks)
  const refreshAllStatus = useIntegrationStore((s) => s.refreshAllStatus)

  // 兜底初始化：监听器正常由 useAppEvents 在 App 级安装，
  // 这里幂等调用以防面板早于 App 事件初始化打开
  useEffect(() => {
    void initialize()
  }, [initialize])

  // 打开面板时刷新任务列表与集成状态（轻量查询）
  useEffect(() => {
    void loadTasks()
    void refreshAllStatus()
  }, [loadTasks, refreshAllStatus])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
        <Activity size={15} className="text-text-tertiary" />
        <span className="text-sm font-medium text-text-primary">{t('title')}</span>
      </div>

      {/* 内容区（可滚动） */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <SectionHeader title={t('section.overview')} />
        <SourceOverview />

        <SectionHeader title={t('section.active')} />
        <ActiveExecutionList />

        <SectionHeader title={t('section.history')} />
        <ExecutionHistoryList />
      </div>
    </div>
  )
}
