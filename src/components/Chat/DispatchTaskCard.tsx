/**
 * 派发任务卡片 - 来源会话内联渲染
 *
 * 工具消息渲染层按 toolName 替换：mcp__polaris-dispatch__dispatch_task 的
 * 工具块渲染为本卡片（chatBlocks/index.tsx 接线）。从 tool_result JSON 解析
 * dispatchId 关联 dispatchStore 实时视图；解析失败降级为通用工具块。
 *
 * 三态：
 * - 执行中：spinner + 耗时 + 最新动作单行 + [打开会话] [中断]
 * - 完成：摘要（3 行截断可展开）+ [打开会话] [追加指令] [让 AI 处理结果]
 * - 失败：错误信息 + [打开会话] [追加指令]
 */

import { memo, useMemo, useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import {
  Rocket,
  Loader2,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Square,
  Send,
  CornerDownRight,
  ChevronDown,
} from 'lucide-react'
import type { ToolCallBlock } from '@/types'
import { useDispatchTask } from '@/stores/dispatchStore'
import {
  openDispatchSession,
  interruptDispatchedTask,
  continueDispatchedTask,
  handOffResultToSource,
} from '@/services/dispatchTaskService'
import { sessionStoreManager } from '@/stores/conversationStore'
import { ToolCallBlockRenderer } from './chatBlocks/ToolCallBlockRenderer'

/** 从 dispatch_task 的 tool_result JSON 解析派发标识 */
function parseDispatchResult(output?: string): {
  dispatchId: string
  sessionId: string
} | null {
  if (!output) return null
  try {
    const parsed = JSON.parse(output) as {
      ok?: boolean
      dispatchId?: string
      sessionId?: string
    }
    if (parsed.ok && parsed.dispatchId && parsed.sessionId) {
      return { dispatchId: parsed.dispatchId, sessionId: parsed.sessionId }
    }
    return null
  } catch {
    return null
  }
}

function formatElapsed(startedAt: number, endedAt?: number): string {
  const ms = (endedAt ?? Date.now()) - startedAt
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min <= 0) return `${sec}s`
  return `${min}m${sec.toString().padStart(2, '0')}s`
}

export const DispatchTaskCard = memo(function DispatchTaskCard({ block }: { block: ToolCallBlock }) {
  const { t } = useTranslation('chat')
  const result = useMemo(() => parseDispatchResult(block.output), [block.output])
  const task = useDispatchTask(result?.dispatchId ?? null)

  const [expanded, setExpanded] = useState(false)
  const [followUpOpen, setFollowUpOpen] = useState(false)
  const [followUpText, setFollowUpText] = useState('')
  const [busy, setBusy] = useState(false)
  // 执行中每秒刷新耗时
  const [, forceTick] = useState(0)
  const running = task?.status === 'running' || task?.status === 'pending'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [running])

  const handleContinue = useCallback(async () => {
    if (!result || !followUpText.trim() || busy) return
    setBusy(true)
    try {
      const ok = await continueDispatchedTask(result.dispatchId, followUpText)
      if (ok) {
        setFollowUpText('')
        setFollowUpOpen(false)
      }
    } finally {
      setBusy(false)
    }
  }, [result, followUpText, busy])

  const handleHandOff = useCallback(async () => {
    if (!result || busy) return
    setBusy(true)
    try {
      await handOffResultToSource(result.dispatchId)
    } finally {
      setBusy(false)
    }
  }, [result, busy])

  // 工具失败 / 派发被拒（并发上限、深度上限）→ 降级通用工具块，让 AI 的错误信息可见
  if (!result) {
    return <ToolCallBlockRenderer block={block} />
  }

  const sessionExists = sessionStoreManager.getState().stores.has(result.sessionId)

  // 无实时视图（应用重启后查看历史）：静态壳
  if (!task) {
    return (
      <div className="my-1.5 rounded-lg border border-border bg-background-elevated px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <Rocket className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="font-medium">{t('dispatch.cardTitle', '派发任务')}</span>
          <span className="text-text-muted truncate">{result.dispatchId.slice(0, 8)}</span>
          <span className="text-text-muted ml-auto shrink-0">
            {t('dispatch.staleCard', '会话已结束或来自历史记录')}
          </span>
          {sessionExists && (
            <button
              type="button"
              className="flex items-center gap-1 text-primary hover:text-primary-hover shrink-0"
              onClick={() => openDispatchSession(result.sessionId)}
            >
              <ExternalLink className="w-3 h-3" />
              {t('dispatch.openSession', '打开会话')}
            </button>
          )}
        </div>
      </div>
    )
  }

  const isDone = task.status === 'completed'
  const isFailed = task.status === 'failed'
  const summaryText = task.summary || (isFailed ? task.error : undefined)
  const summaryLong = (summaryText?.length ?? 0) > 180
  const verdict = task.verdictStatus === 'structured' ? task.verdict : undefined

  return (
    <div
      className={clsx(
        'my-1.5 rounded-lg overflow-hidden border transition-colors',
        running && 'border-primary/30 bg-primary/[0.03]',
        isDone && 'border-success/30 bg-success/[0.03]',
        isFailed && 'border-error/30 bg-error-faint/40'
      )}
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Rocket className="w-4 h-4 text-primary shrink-0" />
        <span className="text-xs font-medium text-text-primary truncate">
          {task.role
            ? t('dispatch.cardTitleWithRole', { defaultValue: '{{role}} · {{title}}', role: task.role, title: task.title })
            : task.title}
        </span>

        <div className="flex items-center gap-1.5 ml-auto shrink-0 text-[10px]">
          {(task.engineId || task.model) && (
            <span className="px-1.5 py-0.5 rounded bg-background-secondary text-text-muted">
              {[task.engineId, task.model].filter(Boolean).join('/')}
            </span>
          )}
          <span className="text-text-muted">
            {formatElapsed(task.startedAt, task.endedAt)}
          </span>
          {running && <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />}
          {isDone && <CheckCircle2 className="w-3.5 h-3.5 text-success" />}
          {isFailed && <XCircle className="w-3.5 h-3.5 text-error" />}
        </div>
      </div>

      {/* 执行中：最新动态 */}
      {running && task.latestActivity && (
        <div className="px-3 pb-2 flex items-center gap-1.5 text-[11px] text-text-tertiary">
          <CornerDownRight className="w-3 h-3 shrink-0" />
          <span className="truncate">{task.latestActivity}</span>
        </div>
      )}

      {/* 终态：结构化 verdict(resultSchema 派发,U1-2) */}
      {(isDone || isFailed) && verdict && <VerdictBlock verdict={verdict} />}

      {/* 终态：摘要 */}
      {(isDone || isFailed) && summaryText && (
        <div className="px-3 pb-2">
          <div
            className={clsx(
              'text-[11px] whitespace-pre-wrap break-words',
              isFailed ? 'text-error' : 'text-text-secondary',
              !expanded && 'line-clamp-3'
            )}
          >
            {summaryText}
          </div>
          {summaryLong && (
            <button
              type="button"
              className="mt-1 flex items-center gap-0.5 text-[10px] text-primary hover:text-primary-hover"
              onClick={() => setExpanded(!expanded)}
            >
              <ChevronDown className={clsx('w-3 h-3 transition-transform', expanded && 'rotate-180')} />
              {expanded ? t('dispatch.collapse', '收起') : t('dispatch.expand', '展开全部')}
            </button>
          )}
        </div>
      )}

      {/* 操作栏 */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border/60 text-[11px]">
        <button
          type="button"
          className="flex items-center gap-1 text-text-secondary hover:text-text-primary transition-colors"
          onClick={() => openDispatchSession(result.sessionId)}
        >
          <ExternalLink className="w-3 h-3" />
          {t('dispatch.openSession', '打开会话')}
        </button>

        {running && (
          <button
            type="button"
            className="flex items-center gap-1 text-error/80 hover:text-error transition-colors"
            onClick={() => void interruptDispatchedTask(result.dispatchId)}
          >
            <Square className="w-3 h-3" />
            {t('dispatch.interrupt', '中断')}
          </button>
        )}

        {(isDone || isFailed) && (
          <>
            <button
              type="button"
              className="flex items-center gap-1 text-text-secondary hover:text-text-primary transition-colors"
              onClick={() => setFollowUpOpen(!followUpOpen)}
            >
              <CornerDownRight className="w-3 h-3" />
              {t('dispatch.followUp', '追加指令')}
            </button>
            {isDone && task.sourceSessionId && (
              <button
                type="button"
                className="flex items-center gap-1 text-primary hover:text-primary-hover transition-colors disabled:opacity-50"
                disabled={busy}
                onClick={() => void handleHandOff()}
              >
                <Send className="w-3 h-3" />
                {t('dispatch.handOff', '让 AI 处理结果')}
              </button>
            )}
          </>
        )}
      </div>

      {/* 追加指令输入 */}
      {followUpOpen && (isDone || isFailed) && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border/60">
          <input
            type="text"
            className="flex-1 min-w-0 text-xs bg-background-surface border border-border rounded px-2 py-1.5 outline-none focus:border-primary/50 text-text-primary placeholder:text-text-muted"
            placeholder={t('dispatch.followUpPlaceholder', '给这个后台会话追加下一步指令...')}
            value={followUpText}
            disabled={busy}
            onChange={(e) => setFollowUpText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void handleContinue()
              }
            }}
          />
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] text-primary hover:text-primary-hover disabled:opacity-50 shrink-0"
            disabled={busy || !followUpText.trim()}
            onClick={() => void handleContinue()}
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
            {t('dispatch.send', '发送')}
          </button>
        </div>
      )}
    </div>
  )
})


// ============================================================================
// 结构化 verdict 渲染(qa-pass/qa-fail/phase-gate/escalation,U1-2)
// ============================================================================

interface VerdictIssue {
  severity?: string
  expected?: string
  actual?: string
  fix_instruction?: string
  file_to_modify?: string
}

function VerdictBlock({ verdict }: { verdict: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const schema = String(verdict.schema ?? '')
  const isPass = schema === 'qa-pass' || (schema === 'phase-gate' && verdict.verdict === 'PASS')
  const isFail = schema === 'qa-fail' || (schema === 'phase-gate' && verdict.verdict === 'FAIL')
  const issues = Array.isArray(verdict.issues) ? (verdict.issues as VerdictIssue[]) : []
  const acceptance = verdict.acceptance as { passed?: number; failed?: number; total?: number } | undefined

  return (
    <div className="px-3 pb-2">
      <div
        className={clsx(
          'rounded-md border px-2 py-1.5 text-[11px]',
          isPass && 'border-success/40 bg-success/[0.05]',
          isFail && 'border-error/40 bg-error-faint/40',
          !isPass && !isFail && 'border-border-subtle'
        )}
      >
        <button
          type="button"
          className="flex w-full items-center gap-1.5"
          onClick={() => setOpen(!open)}
        >
          <span
            className={clsx(
              'rounded px-1.5 py-0.5 text-[10px] font-medium text-white',
              isPass ? 'bg-success' : isFail ? 'bg-error' : 'bg-text-muted'
            )}
          >
            {schema.toUpperCase()}
          </span>
          {acceptance && (
            <span className="text-text-secondary">
              验收 {acceptance.passed ?? 0}/{acceptance.total ?? 0}
            </span>
          )}
          {issues.length > 0 && (
            <span className="text-error">{issues.length} 个问题</span>
          )}
          {schema === 'escalation' && (
            <span className="text-warning">建议处置:{String(verdict.recommendation ?? '')}</span>
          )}
          <ChevronDown
            className={clsx('ml-auto w-3 h-3 shrink-0 text-text-muted transition-transform', open && 'rotate-180')}
          />
        </button>

        {open && issues.length > 0 && (
          <div className="mt-1.5 space-y-1.5">
            {issues.map((issue, i) => (
              <div key={i} className="rounded bg-background-secondary px-2 py-1.5">
                <div>
                  <span className="font-medium text-error">[{issue.severity ?? '?'}]</span>{' '}
                  <span className="text-text-secondary">期望:{issue.expected ?? '—'}</span>
                </div>
                <div className="text-text-tertiary">实际:{issue.actual ?? '—'}</div>
                {issue.fix_instruction && (
                  <div className="text-text-secondary">修复:{issue.fix_instruction}</div>
                )}
                {issue.file_to_modify && (
                  <div className="font-mono text-[10px] text-text-muted">{issue.file_to_modify}</div>
                )}
              </div>
            ))}
          </div>
        )}
        {open && issues.length === 0 && (
          <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] text-text-tertiary">
            {JSON.stringify(verdict, null, 2)}
          </pre>
        )}
      </div>
    </div>
  )
}
