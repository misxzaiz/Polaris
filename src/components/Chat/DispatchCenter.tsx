/**
 * 后台任务中心 - 状态栏入口 + 弹出面板
 *
 * 统一入口查看全部派发任务（含历史，后端注册表持久化）：
 * - 执行中任务：实时状态徽标 + 最新动态 + 打开会话/中断
 * - 历史任务：结论摘要 + 重新派发（相同参数重派）+ 删除记录
 * 数据源 = 后端 dispatch_list_tasks（持久化真相）+ dispatchStore（实时动态）合并
 */

import { memo, useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import {
  Rocket,
  Loader2,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Square,
  RotateCcw,
  Trash2,
  Clock,
} from 'lucide-react'
import { invoke } from '@/services/transport'
import { useDispatchStore, type DispatchTaskStatus } from '@/stores/dispatchStore'
import {
  openDispatchSession,
  interruptDispatchedTask,
  handleDispatchTaskRequest,
  type DispatchTaskRequestEvent,
} from '@/services/dispatchTaskService'
import { sessionStoreManager } from '@/stores/conversationStore'
import { useToastStore } from '@/stores/toastStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('DispatchCenter')

/** 后端注册表记录（DispatchedTask serde camelCase） */
interface DispatchTaskRecord {
  dispatchId: string
  sessionId: string
  sourceSessionId: string
  title: string
  prompt: string
  workDir?: string | null
  engineId?: string | null
  depth: number
  role?: string | null
  modelProfileId?: string | null
  model?: string | null
  status: string
  summary?: string | null
  latestActivity?: string | null
  createdAt: number
  updatedAt: number
}

function formatTime(unixSec: number): string {
  const date = new Date(unixSec * 1000)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const hm = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
  return sameDay ? hm : `${date.getMonth() + 1}/${date.getDate()} ${hm}`
}

const STATUS_STYLES: Record<string, string> = {
  running: 'text-primary',
  pending: 'text-primary',
  completed: 'text-success',
  failed: 'text-error',
}

export const DispatchCenterButton = memo(function DispatchCenterButton() {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const [records, setRecords] = useState<DispatchTaskRecord[]>([])
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  // fixed 定位坐标：按钮可能位于状态栏任意位置，absolute 对齐会向左/右溢出视口，
  // 且受祖先 overflow 裁剪；改为按钮 rect + 视口钳制的 fixed 定位
  const [panelPos, setPanelPos] = useState<{ left: number; bottom: number } | null>(null)

  const PANEL_WIDTH = 340
  const PANEL_MARGIN = 8

  const updatePanelPos = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const maxLeft = window.innerWidth - PANEL_WIDTH - PANEL_MARGIN
    const left = Math.max(PANEL_MARGIN, Math.min(rect.left, maxLeft))
    const bottom = Math.max(PANEL_MARGIN, window.innerHeight - rect.top + PANEL_MARGIN)
    setPanelPos({ left, bottom })
  }, [])

  // 实时任务视图（running 徽标数 + 面板内实时动态）
  const liveTasks = useDispatchStore((s) => s.tasks)
  const runningCount = Array.from(liveTasks.values()).filter(
    (task) => task.status === 'running' || task.status === 'pending'
  ).length

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const tasks = await invoke<DispatchTaskRecord[]>('dispatch_list_tasks', {})
      setRecords(tasks || [])
    } catch (e) {
      log.warn('加载派发任务列表失败', { error: String(e) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      updatePanelPos()
      void refresh()
    }
  }, [open, refresh, updatePanelPos])

  // 窗口尺寸变化时重算面板位置
  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', updatePanelPos)
    return () => window.removeEventListener('resize', updatePanelPos)
  }, [open, updatePanelPos])

  // 点击面板外关闭
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const handleRerun = useCallback(async (record: DispatchTaskRecord) => {
    try {
      const task = await invoke<DispatchTaskRequestEvent>('dispatch_create_task', {
        prompt: record.prompt,
        title: record.title,
        workDir: record.workDir || undefined,
        engineId: record.role ? undefined : record.engineId || undefined,
        role: record.role || undefined,
        provider:
          !record.role && record.modelProfileId && record.modelProfileId !== 'official'
            ? record.modelProfileId
            : undefined,
        model: record.role ? undefined : record.model || undefined,
        sourceSessionId: record.sourceSessionId || undefined,
      })
      await handleDispatchTaskRequest(task, { skipPolicyCheck: true })
      void refresh()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      useToastStore.getState().error(t('dispatch.dispatchFailed', '派发失败'), message)
    }
  }, [refresh, t])

  const handleDelete = useCallback(async (dispatchId: string) => {
    try {
      await invoke('dispatch_delete_task', { dispatchId })
      setRecords((prev) => prev.filter((r) => r.dispatchId !== dispatchId))
    } catch (e) {
      log.warn('删除派发记录失败', { dispatchId, error: String(e) })
    }
  }, [])

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        className={clsx(
          'relative flex items-center px-1.5 py-0.5 rounded transition-colors',
          open || runningCount > 0
            ? 'text-primary hover:bg-background-hover'
            : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
        )}
        title={t('dispatch.centerTooltip', '后台任务中心')}
      >
        <Rocket size={14} />
        {runningCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-primary text-white text-[9px] leading-[14px] text-center">
            {runningCount}
          </span>
        )}
      </button>

      {open && panelPos && (
        <div
          className="fixed w-[340px] max-h-[420px] flex flex-col rounded-lg border border-border bg-background-elevated shadow-lg z-50"
          style={{ left: panelPos.left, bottom: panelPos.bottom }}
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <Rocket className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-medium text-text-primary">
              {t('dispatch.centerTitle', '后台任务中心')}
            </span>
            {loading && <Loader2 className="w-3 h-3 animate-spin text-text-muted" />}
            <span className="ml-auto text-[10px] text-text-muted">
              {t('dispatch.centerCount', { defaultValue: '{{count}} 条记录', count: records.length })}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
            {records.length === 0 && !loading && (
              <div className="py-8 text-center text-xs text-text-muted">
                {t('dispatch.centerEmpty', '暂无派发任务，试试 /dispatch 任务内容')}
              </div>
            )}
            {records.map((record) => {
              const live = liveTasks.get(record.dispatchId)
              const status = (live?.status ?? record.status) as DispatchTaskStatus
              const isActive = status === 'running' || status === 'pending'
              const activity = live?.latestActivity ?? record.latestActivity
              const summary = live?.summary ?? record.summary
              const sessionExists = sessionStoreManager
                .getState()
                .stores.has(record.sessionId)

              return (
                <div
                  key={record.dispatchId}
                  className="px-2.5 py-2 rounded border border-border-subtle bg-background-surface"
                >
                  <div className="flex items-center gap-1.5">
                    {isActive ? (
                      <Loader2 className={clsx('w-3 h-3 animate-spin shrink-0', STATUS_STYLES[status])} />
                    ) : status === 'completed' ? (
                      <CheckCircle2 className="w-3 h-3 text-success shrink-0" />
                    ) : (
                      <XCircle className="w-3 h-3 text-error shrink-0" />
                    )}
                    <span className="text-xs text-text-primary font-medium truncate">
                      {record.role ? `${record.role} · ${record.title}` : record.title}
                    </span>
                    <span className="ml-auto flex items-center gap-1 text-[10px] text-text-muted shrink-0">
                      <Clock className="w-2.5 h-2.5" />
                      {formatTime(record.updatedAt)}
                    </span>
                  </div>

                  {isActive && activity && (
                    <div className="mt-1 text-[10px] text-text-tertiary truncate pl-[18px]">
                      {activity}
                    </div>
                  )}
                  {!isActive && summary && (
                    <div className="mt-1 text-[10px] text-text-tertiary line-clamp-2 pl-[18px]">
                      {summary}
                    </div>
                  )}

                  <div className="mt-1.5 flex items-center gap-2.5 pl-[18px] text-[10px]">
                    {sessionExists && (
                      <button
                        type="button"
                        className="flex items-center gap-0.5 text-text-secondary hover:text-text-primary"
                        onClick={() => {
                          openDispatchSession(record.sessionId)
                          setOpen(false)
                        }}
                      >
                        <ExternalLink className="w-2.5 h-2.5" />
                        {t('dispatch.openSession', '打开会话')}
                      </button>
                    )}
                    {isActive && live && (
                      <button
                        type="button"
                        className="flex items-center gap-0.5 text-error/80 hover:text-error"
                        onClick={() => void interruptDispatchedTask(record.dispatchId)}
                      >
                        <Square className="w-2.5 h-2.5" />
                        {t('dispatch.interrupt', '中断')}
                      </button>
                    )}
                    {!isActive && (
                      <>
                        <button
                          type="button"
                          className="flex items-center gap-0.5 text-text-secondary hover:text-text-primary"
                          onClick={() => void handleRerun(record)}
                        >
                          <RotateCcw className="w-2.5 h-2.5" />
                          {t('dispatch.rerun', '重新派发')}
                        </button>
                        <button
                          type="button"
                          className="flex items-center gap-0.5 text-text-muted hover:text-error ml-auto"
                          onClick={() => void handleDelete(record.dispatchId)}
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                          {t('dispatch.deleteRecord', '删除')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
})

export default DispatchCenterButton
