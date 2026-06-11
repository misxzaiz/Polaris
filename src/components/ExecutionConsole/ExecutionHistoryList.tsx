/**
 * 执行历史时间线 - 控制台第三区
 *
 * 合并两类历史（新→旧）：
 * - 集成执行历史：executionConsoleStore.history（事件驱动写入）
 * - 定时任务执行：schedulerStore.executions 中已结束的条目（success/failed）
 *
 * 聊天会话本身即历史（会话列表），不在此重复展示。
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare, Clock, Bot, CheckCircle2, XCircle, Trash2 } from 'lucide-react'
import { useSchedulerStore } from '@/stores/schedulerStore'
import { useExecutionConsoleStore } from '@/stores/executionConsoleStore'
import type { ExecutionHistoryEntry } from '@/types/executionConsole'
import { formatDuration, formatTime } from './consoleUtils'

const originIcons = {
  chat: MessageSquare,
  scheduler: Clock,
  integration: Bot,
} as const

export function ExecutionHistoryList() {
  const { t } = useTranslation('executionConsole')
  const history = useExecutionConsoleStore((s) => s.history)
  const clearHistory = useExecutionConsoleStore((s) => s.clearHistory)
  const executions = useSchedulerStore((s) => s.executions)

  const entries = useMemo<ExecutionHistoryEntry[]>(() => {
    const merged: ExecutionHistoryEntry[] = [...history]

    // 定时任务已结束的执行（schedulerStore 内存态，应用启动以来）
    for (const execution of executions.values()) {
      if (execution.state !== 'success' && execution.state !== 'failed') continue
      merged.push({
        id: `scheduler-${execution.taskId}-${execution.startTime}`,
        origin: 'scheduler',
        title: execution.taskName,
        summary: '',
        status: execution.state,
        startedAt: execution.startTime,
        endedAt: execution.endTime ?? execution.startTime,
      })
    }

    return merged.sort((a, b) => b.endedAt - a.endedAt)
  }, [history, executions])

  if (entries.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-text-tertiary">
        {t('history.empty')}
      </div>
    )
  }

  return (
    <div className="flex flex-col px-2 pb-2">
      <div className="flex justify-end px-1 pb-1">
        <button
          type="button"
          onClick={clearHistory}
          className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
          title={t('history.clear')}
        >
          <Trash2 size={11} />
          {t('history.clear')}
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        {entries.map((entry) => {
          const Icon = originIcons[entry.origin]
          const success = entry.status === 'success'
          return (
            <div
              key={entry.id}
              className="flex items-start gap-2 px-2 py-1.5 rounded-md hover:bg-background-hover transition-colors"
              title={entry.error || entry.summary || entry.title}
            >
              {success ? (
                <CheckCircle2 size={13} className="shrink-0 mt-0.5 text-success" />
              ) : (
                <XCircle size={13} className="shrink-0 mt-0.5 text-danger" />
              )}
              <Icon size={13} className="shrink-0 mt-0.5 text-text-tertiary" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-text-primary truncate">{entry.title}</div>
                {(entry.error || entry.summary) && (
                  <div className={`text-[10px] truncate ${entry.error ? 'text-danger/80' : 'text-text-tertiary'}`}>
                    {entry.error || entry.summary}
                  </div>
                )}
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[10px] text-text-tertiary tabular-nums">{formatTime(entry.endedAt)}</div>
                <div className="text-[10px] text-text-tertiary tabular-nums">
                  {formatDuration(entry.endedAt - entry.startedAt)}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
