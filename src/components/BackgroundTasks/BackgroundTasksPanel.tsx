/**
 * BackgroundTasksPanel - 后台任务管理面板
 *
 * 展示 bash(background:true) 启动的后台任务：状态、命令、PID、实时日志尾部。
 * 轮询 task_list / task_read_log，支持 kill 与强制刷新。
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw, Square, ChevronDown, ChevronRight, CircleCheck, XCircle, Clock, Trash2 } from 'lucide-react'
import { taskList, taskKill, taskReadLog, type BackgroundTaskInfo } from '@/services/taskService'
import { createLogger } from '@/utils/logger'

const log = createLogger('BackgroundTasks')

const STATUS_STYLE: Record<string, { dot: string; label: string }> = {
  running: { dot: 'bg-emerald-500', label: 'text-emerald-500' },
  done: { dot: 'bg-sky-500', label: 'text-sky-500' },
  failed: { dot: 'bg-red-500', label: 'text-red-500' },
  killed: { dot: 'bg-amber-500', label: 'text-amber-500' },
  timeout: { dot: 'bg-orange-500', label: 'text-orange-500' },
}

const STATUS_ICON: Record<string, typeof Loader2> = {
  running: Loader2,
  done: CircleCheck,
  failed: XCircle,
  killed: Square,
  timeout: Clock,
}

/** 状态徽章 */
function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLE[status] || STATUS_STYLE.done
  const Icon = STATUS_ICON[status] || CircleCheck
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium">
      <Icon className={`w-3 h-3 ${style.dot} ${status === 'running' ? 'animate-spin' : ''}`} />
      <span className={style.label}>{status}</span>
    </span>
  )
}

function TaskRow({
  task,
  expanded,
  onToggle,
  onKill,
}: {
  task: BackgroundTaskInfo
  expanded: boolean
  onToggle: () => void
  onKill: () => void
}) {
  const { t } = useTranslation('common')
  const [logTail, setLogTail] = useState(task.logTail || '')
  const [killing, setKilling] = useState(false)

  // 展开时轮询日志尾部
  useEffect(() => {
    if (!expanded) return
    let alive = true
    const poll = async () => {
      try {
        const tail = await taskReadLog(task.taskId, 200)
        if (alive) setLogTail(tail)
      } catch (e) {
        log.warn('read log failed', { taskId: task.taskId, error: String(e) })
      }
    }
    poll()
    const timer = setInterval(poll, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [expanded, task.taskId])

  const handleKill = async () => {
    setKilling(true)
    try {
      await taskKill(task.taskId)
    } catch (e) {
      log.warn('kill failed', { taskId: task.taskId, error: String(e) })
    } finally {
      setKilling(false)
    }
    onKill()
  }

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 hover:bg-background-hover/60 transition-colors text-left"
        onClick={onToggle}
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-text-muted" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-text-muted" />}
        <StatusBadge status={task.status} />
        <span className="flex-1 min-w-0 font-mono text-xs truncate text-text-primary">
          {task.command || '(empty command)'}
        </span>
        <span className="text-xs text-text-muted shrink-0 font-mono">PID {task.pid}</span>
        <span className="text-xs text-text-muted shrink-0 font-mono w-14 text-right">
          {formatElapsed(task.elapsedMs)}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          <div className="flex items-center gap-4 text-xs text-text-muted flex-wrap">
            <span>taskId: <code className="font-mono">{task.taskId}</code></span>
            {task.exitCode != null && <span>exit: <code className="font-mono">{task.exitCode}</code></span>}
            {task.logPath && <span className="truncate max-w-[260px]">log: <code className="font-mono">{task.logPath}</code></span>}
            <button
              onClick={handleKill}
              disabled={killing || task.status !== 'running'}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-red-500/10 text-red-500 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {killing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
              {t('labels.kill', { defaultValue: 'Kill' })}
            </button>
          </div>
          <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap bg-background-base/60 rounded p-2 max-h-48 overflow-auto text-text-primary">
            {logTail || '(no output yet)'}
          </pre>
        </div>
      )}
    </div>
  )
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${s % 60}s`
}

/** 面板主组件 */
export function BackgroundTasksPanel() {
  const { t } = useTranslation('common')
  const [tasks, setTasks] = useState<BackgroundTaskInfo[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLastError(null)
      const list = await taskList()
      setTasks(list)
      // 展开项消失时自动折叠
      setExpandedId((prev) => (prev && list.some((x) => x.taskId === prev) ? prev : null))
    } catch (e) {
      setLastError(String(e))
      log.warn('task list failed', { error: String(e) })
    } finally {
      setLoading(false)
    }
  }, [])

  // 挂载 + 每 3s 轮询（面板保活：组件常驻，切走不卸载）
  useEffect(() => {
    refresh()
    timerRef.current = setInterval(() => {
      setLoading(true)
      refresh()
    }, 3000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [refresh])

  const runningCount = tasks.filter((x) => x.status === 'running').length

  return (
    <div data-theme-panel className="flex flex-col h-full min-h-0 bg-background-elevated">
      {/* 面板头部 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5">
          <Loader2 className="w-4 h-4 text-emerald-500" />
          <span className="text-sm font-medium text-text-primary">{t('labels.backgroundTasks', { defaultValue: 'Background Tasks' })}</span>
        </div>
        {runningCount > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500">
            {runningCount} {t('labels.running', { defaultValue: 'running' })}
          </span>
        )}
        <button
          onClick={() => { setLoading(true); refresh() }}
          className="ml-auto p-1 rounded hover:bg-background-hover text-text-muted hover:text-text-primary transition-colors"
          title={t('labels.refresh', { defaultValue: 'Refresh' })}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-auto">
        {lastError && (
          <div className="px-3 py-2 text-xs text-red-500">{lastError}</div>
        )}
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-text-muted p-6">
            <Trash2 className="w-8 h-8 opacity-40" />
            <p className="text-sm">{t('labels.noBackgroundTasks', { defaultValue: 'No background tasks yet' })}</p>
            <p className="text-xs text-center">
              {t('labels.backgroundTasksHint', {
                defaultValue: 'Ask the AI to run a long command with background mode to see it here.',
              })}
            </p>
          </div>
        ) : (
          tasks.map((task) => (
            <TaskRow
              key={task.taskId}
              task={task}
              expanded={expandedId === task.taskId}
              onToggle={() => setExpandedId((prev) => (prev === task.taskId ? null : task.taskId))}
              onKill={refresh}
            />
          ))
        )}
      </div>
    </div>
  )
}
