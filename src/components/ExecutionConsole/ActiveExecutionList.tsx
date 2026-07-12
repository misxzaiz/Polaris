/**
 * 实时执行列表 - 控制台第二区（核心区）
 *
 * 统一展示三类来源的"正在运行"项：
 * - 聊天会话：status ∈ running / waiting / background-running
 * - 定时任务：schedulerStore.executions 中 state === 'running'
 * - 集成执行：executionConsoleStore.integrationRuns 中 status === 'running'
 *
 * 点击 chat / scheduler 项跳转到对应会话（makeSessionVisible）；
 * 集成项展开显示文本预览（其会话在 Rust 侧，不可跳转）。
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare, Clock, Bot, ChevronDown, ChevronRight } from 'lucide-react'
import { StatusSymbol } from '@/components/QuickSwitchPanel/StatusSymbol'
import {
  sessionStoreManager,
  useSessionMetadataList,
} from '@/stores/conversationStore/sessionStoreManager'
import { useSchedulerStore } from '@/stores/schedulerStore'
import { useExecutionConsoleStore, selectActiveIntegrationRuns } from '@/stores/executionConsoleStore'
import { useViewStore } from '@/stores/viewStore'
import type { SessionStatus } from '@/types/session'
import type { IntegrationRun } from '@/types/executionConsole'
import { formatDuration } from './consoleUtils'

/** 统一的实时执行项视图模型 */
interface ActiveItem {
  key: string
  origin: 'chat' | 'scheduler' | 'integration'
  title: string
  status: SessionStatus
  /** 排序与时长计算基准（chat 无开始时间，用 lastAccessedAt 近似） */
  startedAt: number
  /** 是否可跳转到会话 */
  jumpSessionId?: string
  /** 集成执行详情（仅 integration） */
  integrationRun?: IntegrationRun
}

const originIcons = {
  chat: MessageSquare,
  scheduler: Clock,
  integration: Bot,
} as const

/** 每秒刷新一次的当前时间（仅在有运行项时启动定时器） */
function useNowTicker(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [enabled])
  return now
}

export function ActiveExecutionList() {
  const { t } = useTranslation('executionConsole')
  const sessions = useSessionMetadataList()
  const executions = useSchedulerStore((s) => s.executions)
  const integrationRuns = useExecutionConsoleStore(selectActiveIntegrationRuns)
  const setLeftPanelType = useViewStore((s) => s.setLeftPanelType)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  const items = useMemo<ActiveItem[]>(() => {
    const list: ActiveItem[] = []

    // 聊天会话（含 scheduler 自动创建的后台会话，按 id 前缀归类为 scheduler）
    for (const session of sessions) {
      if (session.status === 'running' || session.status === 'waiting' || session.status === 'background-running') {
        const isSchedulerSession = session.id.startsWith('scheduler-')
        list.push({
          key: `session-${session.id}`,
          origin: isSchedulerSession ? 'scheduler' : 'chat',
          title: session.title || session.id,
          status: session.status,
          startedAt: session.lastAccessedAt,
          jumpSessionId: session.id,
        })
      }
    }

    // 定时任务执行（schedulerStore 自己维护的执行状态；
    // 若已有同名 scheduler 会话项则跳过，避免重复）
    for (const execution of executions.values()) {
      if (execution.state !== 'running') continue
      const sessionKey = `session-scheduler-${execution.taskId}`
      if (list.some((item) => item.key === sessionKey)) continue
      list.push({
        key: `task-${execution.taskId}`,
        origin: 'scheduler',
        title: execution.taskName,
        status: 'running',
        startedAt: execution.startTime,
        jumpSessionId: sessionStoreManager.getState().sessionMetadata.has(`scheduler-${execution.taskId}`)
          ? `scheduler-${execution.taskId}`
          : undefined,
      })
    }

    // 集成执行
    for (const run of integrationRuns) {
      list.push({
        key: `integration-${run.conversationId}`,
        origin: 'integration',
        title: run.senderName || run.conversationId,
        status: 'running',
        startedAt: run.startedAt,
        integrationRun: run,
      })
    }

    // 新开始的在前
    return list.sort((a, b) => b.startedAt - a.startedAt)
  }, [sessions, executions, integrationRuns])

  const now = useNowTicker(items.length > 0)

  const handleItemClick = (item: ActiveItem) => {
    if (item.integrationRun) {
      setExpandedKey((prev) => (prev === item.key ? null : item.key))
      return
    }
    if (item.jumpSessionId) {
      sessionStoreManager.getState().makeSessionVisible(item.jumpSessionId)
      return
    }
    if (item.origin === 'scheduler') {
      // 无会话可跳转时退回定时任务面板
      setLeftPanelType('scheduler')
    }
  }

  if (items.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-text-tertiary">
        {t('active.empty')}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0.5 px-2">
      {items.map((item) => {
        const Icon = originIcons[item.origin]
        const expanded = expandedKey === item.key
        const isExpandable = !!item.integrationRun
        return (
          <div key={item.key}>
            <button
              type="button"
              onClick={() => handleItemClick(item)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-background-hover transition-colors text-left"
              title={item.title}
            >
              <StatusSymbol status={item.status} size="sm" className="shrink-0" />
              <Icon size={13} className="shrink-0 text-text-tertiary" />
              <span className="flex-1 min-w-0 text-xs text-text-primary truncate">{item.title}</span>
              <span className="shrink-0 text-[10px] text-text-tertiary tabular-nums">
                {formatDuration(now - item.startedAt)}
              </span>
              {isExpandable && (
                expanded
                  ? <ChevronDown size={12} className="shrink-0 text-text-tertiary" />
                  : <ChevronRight size={12} className="shrink-0 text-text-tertiary" />
              )}
            </button>
            {expanded && item.integrationRun && (
              <div className="mx-2 mb-1 px-2.5 py-2 rounded-md bg-background-base border border-border text-[11px] leading-relaxed">
                <div className="text-text-tertiary mb-0.5">
                  {t(`platform.${item.integrationRun.platform}`, { defaultValue: item.integrationRun.platform })}
                  {' · '}
                  {item.integrationRun.conversationId}
                </div>
                {item.integrationRun.promptPreview && (
                  <div className="text-text-secondary break-all">
                    <span className="text-text-tertiary">{t('active.prompt')}: </span>
                    {item.integrationRun.promptPreview}
                  </div>
                )}
                {item.integrationRun.lastOutputPreview && (
                  <div className="text-text-secondary break-all mt-0.5">
                    <span className="text-text-tertiary">{t('active.output')}: </span>
                    {item.integrationRun.lastOutputPreview}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
