/**
 * 面板化 Interactive Rebase 对话框（P3 FR-P3-2）
 *
 * 流程：Log 右键「Interactively Rebase from Here」→ 后端 plan（base..HEAD 应用序）
 * → 本对话框编辑（reorder + pick/drop/squash/fixup）→ 确认注入执行（写类）。
 *
 * 后端只是把面板 todo 渲染为 git inner todo 并 GIT_SEQUENCE_EDITOR 注入执行
 * （详见 rebase.rs 注释）。冲突走既有 rebase_continue/abort + 冲突合并器闭环。
 *
 * 约束（git 语义，前端 live 校验，后端兜底）：
 * - 首项必须是 pick（firstLocked）
 * - squash/fixup 的前一项必须是 pick 或 reword（drop 会隔断组）
 *
 * C1 reword（本轮增量）：切到 reword → 行内改写标题（newMessage）；执行时后端
 * 预写消息文件并经 GIT_EDITOR 脚本按 todo 序回放（rebase.rs write_reword_assets）。
 * 未支持（如实标注增量）：拖拽（用上下移按钮替代，Virtuoso 拖拽语义放增量→ C2 落地）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowDown, ArrowUp, Loader2, ListTodo, X, Check, Sparkles } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useToastStore } from '@/stores/toastStore'
import { parseGitError } from '@/stores/gitStore/types'
import type { GitRebasePlan, GitRebaseTodoAction, GitRebaseTodoItem } from '@/types/git'

interface RebaseTodoDialogProps {
  workspacePath: string
  /** 变基起点（commit sha；来自 Log 右键） */
  baseCommitish: string
  onClose: () => void
  /** 执行结束（成功或已进入冲突序列）回调 */
  onDone: () => void
}

const ACTION_ORDER: GitRebaseTodoAction[] = ['pick', 'reword', 'drop', 'squash', 'fixup']

const ACTION_BADGE_CLASS: Record<GitRebaseTodoAction, string> = {
  pick: 'bg-primary/10 text-primary border-primary/30',
  reword: 'bg-secondary/10 text-secondary border-secondary/30',
  drop: 'bg-danger/10 text-danger border-danger/30',
  squash: 'bg-warning/10 text-warning border-warning/30',
  fixup: 'bg-warning/10 text-warning border-warning/30',
}

/** squash/fixup 必须紧跟 pick 或 reword（git 语义：两者都会产生提交承载合并） */
function isTodoValid(todos: GitRebaseTodoItem[]): boolean {
  if (todos.length === 0) return false
  if (todos[0].action !== 'pick') return false
  for (let i = 1; i < todos.length; i++) {
    const a = todos[i].action
    if ((a === 'squash' || a === 'fixup') && todos[i - 1].action !== 'pick' && todos[i - 1].action !== 'reword') return false
  }
  return true
}

export function RebaseTodoDialog({ workspacePath, baseCommitish, onClose, onDone }: RebaseTodoDialogProps) {
  const { t } = useTranslation('git')
  const toast = useToastStore()
  const planInteractiveRebase = useGitStore((s) => s.planInteractiveRebase)
  const startInteractiveRebase = useGitStore((s) => s.startInteractiveRebase)
  const suggestRebaseTodos = useGitStore((s) => s.suggestRebaseTodos)

  const [plan, setPlan] = useState<GitRebasePlan | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [todos, setTodos] = useState<GitRebaseTodoItem[]>([])
  const [autosquash, setAutosquash] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [suggesting, setSuggesting] = useState(false)

  /** P3 AI-8：拉取 fixup!/squash! 整理建议并整表套用（覆盖当前手动编辑；toast 汇报 moved/unmatched） */
  const applySuggestion = useCallback(async () => {
    if (suggesting) return
    setSuggesting(true)
    try {
      const s = await suggestRebaseTodos(workspacePath, baseCommitish)
      setTodos(s.commits)
      if (s.unmatched.length > 0) {
        toast.warning(t('rebaseTodo.suggestPartial', {
          moved: s.movedCount,
          unmatched: s.unmatched.length,
          shas: s.unmatched.slice(0, 3).join(', '),
        }))
      } else if (s.movedCount > 0) {
        toast.success(t('rebaseTodo.suggestApplied', { moved: s.movedCount }))
      } else {
        toast.info(t('rebaseTodo.suggestNone'))
      }
    } catch (err) {
      toast.error(parseGitError(err))
    } finally {
      setSuggesting(false)
    }
  }, [suggesting, suggestRebaseTodos, workspacePath, baseCommitish, toast, t])

  useEffect(() => {
    let cancelled = false
    planInteractiveRebase(workspacePath, baseCommitish)
      .then((p) => {
        if (cancelled) return
        setPlan(p)
        setTodos(p.commits)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(parseGitError(err))
      })
    return () => {
      cancelled = true
    }
  }, [workspacePath, baseCommitish, planInteractiveRebase])

  /** 行动作切换（首项锁定 pick）；切到 reword 时用现 subject 预填新消息 */
  const setAction = useCallback((index: number, action: GitRebaseTodoAction) => {
    setTodos((prev) => {
      if (index === 0) return prev
      const next = [...prev]
      const item = next[index]
      if (action === 'reword') {
        next[index] = { ...item, action, newMessage: item.newMessage ?? item.subject }
      } else {
        // 离开 reword → 清掉残留新消息（避免串到后续编辑/快照）
        const { newMessage: _dropped, ...rest } = item
        next[index] = { ...rest, action }
      }
      return next
    })
  }, [])

  /** C1 reword：行内编辑新标题 */
  const setNewMessage = useCallback((index: number, message: string) => {
    setTodos((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], newMessage: message }
      return next
    })
  }, [])

  /** 上下移（首项不可上移；组内 swap 会触发 live 校验高亮） */
  const swap = useCallback((index: number, dir: -1 | 1) => {
    setTodos((prev) => {
      const j = index + dir
      if (index === 0 || j < 1 || j >= prev.length) return prev
      const next = [...prev]
      const tmp = next[index]
      next[index] = next[j]
      next[j] = tmp
      return next
    })
  }, [])

  // ── C2 拖拽排序（HTML5 原生 DnD，与上下移按钮并存）─────────────────
  // 约束：首项锁定（不可被拖走，也不可把它拖下来换位）；拖拽 = 等价 swap 的
  // splice 移动，落到非法位置时还原（live 校验/后端兜底不变）。
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const handleDragStart = useCallback(
    (index: number) => {
      if (index === 0) return
      setDragIndex(index)
    },
    [],
  )

  const handleDrop = useCallback(
    (targetIndex: number) => {
      setOverIndex(null)
      if (dragIndex === null || dragIndex === 0 || targetIndex === 0 || dragIndex === targetIndex) {
        setDragIndex(null)
        return
      }
      const from = dragIndex
      setTodos((prev) => {
        if (from >= prev.length) return prev
        const next = [...prev]
        const [moved] = next.splice(from, 1)
        next.splice(targetIndex, 0, moved)
        return next
      })
      setDragIndex(null)
    },
    [dragIndex],
  )

  const invalid = useMemo(() => !isTodoValid(todos), [todos])
  const counts = useMemo(() => {
    const c: Record<GitRebaseTodoAction, number> = { pick: 0, reword: 0, drop: 0, squash: 0, fixup: 0 }
    for (const it of todos) c[it.action]++
    return c
  }, [todos])

  const execute = async () => {
    if (executing || invalid) return
    setExecuting(true)
    try {
      const result = await startInteractiveRebase(workspacePath, baseCommitish, todos, autosquash)
      if (result.hasConflicts) {
        toast.info(t('rebaseTodo.conflictTakenOver', { count: result.conflicts.length }))
      } else {
        toast.success(t('rebaseTodo.success'))
      }
      onDone()
    } catch (err) {
      toast.error(parseGitError(err))
      setExecuting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-modal flex items-center justify-center p-6" data-testid="rebase-todo-dialog">
      <div className="bg-background-elevated rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-lg border border-border">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <ListTodo size={16} className="text-primary" />
            {t('rebaseTodo.title')}
            {plan && (
              <span className="text-xs text-text-tertiary font-normal ml-1" title={baseCommitish}>
                {t('rebaseTodo.baseShort', { sha: baseCommitish.slice(0, 8) })}
              </span>
            )}
          </h2>
          <button
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {loadError ? (
          <div className="px-4 py-8 text-center text-sm text-danger">
            <AlertTriangle size={18} className="inline mr-1" />
            {loadError}
          </div>
        ) : !plan ? (
          <div className="flex-1 flex items-center justify-center py-10">
            <Loader2 size={18} className="animate-spin text-text-tertiary" />
          </div>
        ) : todos.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-text-secondary">
            {t('rebaseTodo.nothingToRebase')}
          </div>
        ) : (
          <>
            <div className="px-4 py-2 border-b border-border bg-background-hover/30 text-xs text-text-secondary">
              {t('rebaseTodo.summary', {
                pick: counts.pick, reword: counts.reword, drop: counts.drop, squash: counts.squash, fixup: counts.fixup,
              })}
            </div>

            <div className="flex-1 overflow-auto p-2 space-y-1">
              {todos.map((item, i) => {
                const badRow =
                  (i === 0 && item.action !== 'pick') ||
                  ((item.action === 'squash' || item.action === 'fixup') && i > 0 && todos[i - 1].action !== 'pick' && todos[i - 1].action !== 'reword')
                return (
                  <div
                    key={`${item.sha}-${i}`}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-md border ${
                      badRow
                        ? 'border-danger/40 bg-danger/5'
                        : overIndex === i && dragIndex !== null && dragIndex !== i
                          ? 'border-primary/60 bg-primary/5'
                          : 'border-border bg-background-surface'
                    }`}
                    draggable={i !== 0}
                    onDragStart={() => handleDragStart(i)}
                    onDragOver={(e) => {
                      if (dragIndex === null || dragIndex === i || i === 0) return
                      e.preventDefault()
                      setOverIndex(i)
                    }}
                    onDragLeave={() => setOverIndex((cur) => (cur === i ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault()
                      handleDrop(i)
                    }}
                    onDragEnd={() => {
                      setDragIndex(null)
                      setOverIndex(null)
                    }}
                    data-testid={`todo-row-${i}`}
                  >
                    <span className="w-6 text-xs text-text-tertiary text-right">{i + 1}</span>
                    <select
                      className="text-xs px-1 py-0.5 rounded border border-border bg-background-elevated text-text-primary disabled:opacity-40"
                      value={item.action}
                      disabled={i === 0}
                      onChange={(e) => setAction(i, e.target.value as GitRebaseTodoAction)}
                      title={i === 0 ? t('rebaseTodo.firstLocked') : undefined}
                      data-testid={`todo-action-${i}`}
                    >
                      {ACTION_ORDER.map((a) => (
                        <option key={a} value={a}>{a}</option>
                      ))}
                    </select>
                    <span className={`text-[10px] px-1 rounded border ${ACTION_BADGE_CLASS[item.action]}`}>
                      {t(`rebaseTodo.action.${item.action}`)}
                    </span>
                    <span className="text-xs font-mono text-text-tertiary">{item.sha.slice(0, 7)}</span>
                    {item.action === 'reword' ? (
                      <input
                        className="text-xs text-text-primary bg-background-elevated border border-border rounded px-1.5 py-0.5 flex-1 min-w-0 focus:border-primary/60 outline-none"
                        value={item.newMessage ?? item.subject}
                        onChange={(e) => setNewMessage(i, e.target.value)}
                        placeholder={t('rebaseTodo.newSubjectPlaceholder')}
                        data-testid={`todo-reword-input-${i}`}
                      />
                    ) : (
                      <span className="text-xs text-text-primary truncate flex-1" title={item.subject}>
                        {item.subject}
                      </span>
                    )}
                    {badRow && <AlertTriangle size={12} className="text-danger shrink-0" />}
                    <button
                      className="p-0.5 text-text-tertiary hover:text-text-primary disabled:opacity-30"
                      disabled={i <= 1}
                      onClick={() => swap(i, -1)}
                      title={t('rebaseTodo.moveUp')}
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      className="p-0.5 text-text-tertiary hover:text-text-primary disabled:opacity-30"
                      disabled={i >= todos.length - 1}
                      onClick={() => swap(i, 1)}
                      title={t('rebaseTodo.moveDown')}
                    >
                      <ArrowDown size={12} />
                    </button>
                  </div>
                )
              })}
            </div>

            <div className="px-4 py-2 border-t border-border flex items-center gap-2 text-xs text-text-secondary">
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autosquash}
                  onChange={(e) => setAutosquash(e.target.checked)}
                  className="accent-primary"
                  data-testid="autosquash-toggle"
                />
                {t('rebaseTodo.autosquash')}
              </label>
              <span className="text-text-tertiary">--autosquash</span>
            </div>

            {invalid && (
              <div className="px-4 py-1.5 text-xs text-danger bg-danger/5 border-t border-danger/20 flex items-center gap-1.5">
                <AlertTriangle size={12} />
                {t('rebaseTodo.invalidOrder')}
              </div>
            )}
          </>
        )}

        <div className="flex justify-between items-center px-4 py-3 border-t border-border">
          <div className="flex flex-col gap-1 min-w-0">
            <button
              className="text-xs text-text-secondary hover:text-primary transition-colors flex items-center gap-1 disabled:opacity-40 self-start"
              disabled={!plan || todos.length === 0 || suggesting || executing}
              onClick={() => void applySuggestion()}
              title={t('rebaseTodo.suggestHint')}
              data-testid="ai8-suggest"
            >
              {suggesting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {t('rebaseTodo.suggestBtn')}
            </button>
            <span className="text-[11px] text-text-tertiary truncate">{t('rebaseTodo.rewordHint')}</span>
          </div>
          <div className="flex gap-2">
            <button
              className="text-xs px-3 py-1.5 rounded border border-border text-text-secondary hover:bg-background-hover transition-colors"
              onClick={onClose}
            >
              {t('rebaseTodo.cancel')}
            </button>
            <button
              className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center gap-1"
              disabled={!plan || todos.length === 0 || invalid || executing}
              onClick={execute}
              data-testid="rebase-execute"
            >
              {executing ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {t('rebaseTodo.execute')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
