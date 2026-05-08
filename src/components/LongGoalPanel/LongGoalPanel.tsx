import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Pause, Play, Plus, RefreshCw, Send, Square, Wrench } from 'lucide-react'
import { useConfigStore, useWorkspaceStore } from '@/stores'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import {
  appendLongGoalSupplement,
  bindLongGoalSession,
  completeLongGoal,
  createLongGoal,
  listLongGoals,
  pauseLongGoal,
  prepareLongGoalExecution,
  prepareLongGoalMaintenance,
  prepareLongGoalPlanning,
  resumeLongGoal,
  type LongGoalPhase,
  type LongGoalState,
  type LongGoalStatus,
} from '@/services/longGoalService'
import type { EngineId } from '@/types'

const engineOptions: Array<{ id: EngineId; label: string }> = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'OpenAI Codex' },
]

const statusLabel: Record<LongGoalStatus, string> = {
  planning: '规划中',
  active: '执行中',
  running: '会话运行中',
  paused: '已暂停',
  maintenance: '维护中',
  blocked: '等待补充',
  completed: '已完成',
  failed: '失败',
}

export function LongGoalPanel() {
  const config = useConfigStore((state) => state.config)
  const currentWorkspace = useWorkspaceStore((state) => state.getCurrentWorkspace())
  const [goals, setGoals] = useState<LongGoalState[]>([])
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [goalText, setGoalText] = useState('')
  const [engineId, setEngineId] = useState<EngineId>((config?.defaultEngine ?? 'claude-code') as EngineId)
  const [interval, setInterval] = useState('30m')
  const [autoStartPlanning, setAutoStartPlanning] = useState(true)
  const [supplement, setSupplement] = useState('')
  const [maintenancePrompt, setMaintenancePrompt] = useState<string | null>(null)

  const workspacePath = currentWorkspace?.path
  const selectedGoal = useMemo(
    () => goals.find((goal) => goal.config.id === selectedGoalId) ?? goals[0] ?? null,
    [goals, selectedGoalId]
  )

  const refresh = useCallback(async () => {
    if (!workspacePath) {
      setGoals([])
      setSelectedGoalId(null)
      return
    }

    setLoading(true)
    setMessage(null)
    try {
      const next = await listLongGoals(workspacePath)
      setGoals(next)
      setSelectedGoalId((current) => {
        if (current && next.some((goal) => goal.config.id === current)) return current
        return next[0]?.config.id ?? null
      })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [workspacePath])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const handleLongGoalUpdated = () => {
      void refresh()
    }
    window.addEventListener('long-goal:updated', handleLongGoalUpdated)
    return () => window.removeEventListener('long-goal:updated', handleLongGoalUpdated)
  }, [refresh])

  useEffect(() => {
    if (config?.defaultEngine) {
      setEngineId(config.defaultEngine as EngineId)
    }
  }, [config?.defaultEngine])

  const updateSelectedGoal = useCallback((updated: LongGoalState) => {
    setGoals((current) => (
      current.some((goal) => goal.config.id === updated.config.id)
        ? current.map((goal) => goal.config.id === updated.config.id ? updated : goal)
        : [updated, ...current]
    ))
    setSelectedGoalId(updated.config.id)
  }, [])

  const handleAppendSupplement = useCallback(async () => {
    if (!workspacePath || !selectedGoal || !supplement.trim()) return
    setLoading(true)
    setMessage(null)
    try {
      updateSelectedGoal(await appendLongGoalSupplement({
        workspacePath,
        goalId: selectedGoal.config.id,
        content: supplement.trim(),
        priority: 'normal',
      }))
      setSupplement('')
      setMessage('补充已追加')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [selectedGoal, supplement, updateSelectedGoal, workspacePath])

  const handlePause = useCallback(async () => {
    if (!workspacePath || !selectedGoal) return
    setLoading(true)
    try {
      updateSelectedGoal(await pauseLongGoal(workspacePath, selectedGoal.config.id))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [selectedGoal, updateSelectedGoal, workspacePath])

  const handleInterruptCurrentSession = useCallback(async () => {
    if (!workspacePath || !selectedGoal?.config.currentSessionId) return
    setLoading(true)
    setMessage(null)
    try {
      await sessionStoreManager.getState().interruptSession(selectedGoal.config.currentSessionId)
      updateSelectedGoal(await pauseLongGoal(workspacePath, selectedGoal.config.id))
      setMessage('已中断当前会话并暂停目标')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [selectedGoal, updateSelectedGoal, workspacePath])

  const handleResume = useCallback(async () => {
    if (!workspacePath || !selectedGoal) return
    setLoading(true)
    try {
      updateSelectedGoal(await resumeLongGoal(workspacePath, selectedGoal.config.id))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [selectedGoal, updateSelectedGoal, workspacePath])

  const handleMaintenance = useCallback(async () => {
    if (!workspacePath || !selectedGoal) return
    setLoading(true)
    try {
      setMaintenancePrompt(await prepareLongGoalMaintenance(workspacePath, selectedGoal.config.id))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [selectedGoal, workspacePath])

  const startGoalSession = useCallback(async (
    prompt: string,
    sessionTitle: string,
    goal: LongGoalState,
    phase: LongGoalPhase
  ) => {
    if (!workspacePath) return
    const sessionId = sessionStoreManager.getState().createSession({
      type: 'project',
      title: sessionTitle,
      workspaceId: currentWorkspace?.id,
      engineId: goal.config.engineId,
    })
    sessionStoreManager.getState().switchSession(sessionId)

    const store = sessionStoreManager.getState().getStore(sessionId)
    if (!store) {
      throw new Error('无法创建长期目标会话')
    }
    updateSelectedGoal(await bindLongGoalSession({
      workspacePath,
      goalId: goal.config.id,
      sessionId,
      phase,
    }))
    await store.sendMessage(prompt, workspacePath)
  }, [currentWorkspace?.id, updateSelectedGoal, workspacePath])

  const handleCreate = useCallback(async () => {
    if (!workspacePath || !title.trim() || !goalText.trim()) return

    setLoading(true)
    setMessage(null)
    try {
      const created = await createLongGoal({
        title: title.trim(),
        goal: goalText.trim(),
        workspacePath,
        engineId,
        interval: interval.trim() || '30m',
        autoPauseOnComplete: true,
        allowCodeChanges: true,
        allowGitCommit: true,
      })
      setTitle('')
      setGoalText('')
      updateSelectedGoal(created)

      if (autoStartPlanning) {
        const prompt = await prepareLongGoalPlanning(workspacePath, created.config.id)
        await startGoalSession(prompt, `长期目标规划: ${created.config.title}`, created, 'planning')
        setMessage('长期目标已创建，已启动规划会话')
      } else {
        setMessage('长期目标已创建')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [
    autoStartPlanning,
    engineId,
    goalText,
    interval,
    startGoalSession,
    title,
    updateSelectedGoal,
    workspacePath,
  ])

  const handlePlanningSession = useCallback(async () => {
    if (!workspacePath || !selectedGoal) return
    setLoading(true)
    setMessage(null)
    try {
      const prompt = await prepareLongGoalPlanning(workspacePath, selectedGoal.config.id)
      await startGoalSession(prompt, `长期目标规划: ${selectedGoal.config.title}`, selectedGoal, 'planning')
      setMessage('已创建规划会话')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [selectedGoal, startGoalSession, workspacePath])

  const handleExecutionSession = useCallback(async () => {
    if (!workspacePath || !selectedGoal) return
    setLoading(true)
    setMessage(null)
    try {
      const prompt = await prepareLongGoalExecution(workspacePath, selectedGoal.config.id)
      await startGoalSession(prompt, `长期目标执行: ${selectedGoal.config.title}`, selectedGoal, 'execution')
      setMessage('已创建执行会话')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [selectedGoal, startGoalSession, workspacePath])

  const handleMaintenanceSession = useCallback(async () => {
    if (!workspacePath || !selectedGoal) return
    setLoading(true)
    setMessage(null)
    try {
      const prompt = await prepareLongGoalMaintenance(workspacePath, selectedGoal.config.id)
      setMaintenancePrompt(prompt)
      await startGoalSession(prompt, `长期目标维护: ${selectedGoal.config.title}`, selectedGoal, 'maintenance')
      setMessage('已创建维护会话')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [selectedGoal, startGoalSession, workspacePath])

  const handleComplete = useCallback(async () => {
    if (!workspacePath || !selectedGoal) return
    setLoading(true)
    try {
      updateSelectedGoal(await completeLongGoal({
        workspacePath,
        goalId: selectedGoal.config.id,
        completionSummary: '用户在面板中手动标记完成，等待复审。',
        reviewSuggestions: ['复审目标文档和最近会话结果后决定是否继续。'],
      }))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [selectedGoal, updateSelectedGoal, workspacePath])

  if (!workspacePath) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-sm text-text-tertiary">
        打开工作区后可管理长期目标
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background-elevated">
      <div className="border-b border-border-subtle px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">长期目标</h2>
            <div className="mt-0.5 truncate text-xs text-text-tertiary">{currentWorkspace?.name}</div>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border-subtle text-text-secondary hover:bg-background-hover disabled:opacity-50"
            title="刷新"
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <section className="space-y-2">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="目标标题"
            className="w-full rounded-md border border-border-subtle bg-background-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
          />
          <textarea
            value={goalText}
            onChange={(event) => setGoalText(event.target.value)}
            placeholder="长期目标"
            rows={4}
            className="w-full resize-none rounded-md border border-border-subtle bg-background-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              value={engineId}
              onChange={(event) => setEngineId(event.target.value as EngineId)}
              className="rounded-md border border-border-subtle bg-background-surface px-2 py-2 text-xs text-text-secondary"
            >
              {engineOptions.map((engine) => (
                <option key={engine.id} value={engine.id}>{engine.label}</option>
              ))}
            </select>
            <input
              value={interval}
              onChange={(event) => setInterval(event.target.value)}
              className="rounded-md border border-border-subtle bg-background-surface px-2 py-2 text-xs text-text-secondary"
              placeholder="30m"
            />
          </div>
          <label className="flex items-center gap-2 rounded-md border border-border-subtle bg-background-surface px-3 py-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={autoStartPlanning}
              onChange={(event) => setAutoStartPlanning(event.target.checked)}
              className="h-3.5 w-3.5"
            />
            创建后自动启动规划会话
          </label>
          <button
            type="button"
            onClick={handleCreate}
            disabled={loading || !title.trim() || !goalText.trim()}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-primary hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={15} />
            创建长期目标
          </button>
        </section>

        {message && <div className="mt-3 text-xs text-text-tertiary">{message}</div>}

        <section className="mt-4 space-y-2">
          {goals.map((goal) => (
            <button
              key={goal.config.id}
              type="button"
              onClick={() => {
                setSelectedGoalId(goal.config.id)
                setMaintenancePrompt(null)
              }}
              className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                selectedGoal?.config.id === goal.config.id
                  ? 'border-primary/40 bg-primary/10'
                  : 'border-border-subtle bg-background-surface hover:bg-background-hover'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-text-primary">{goal.config.title}</span>
                <span className="shrink-0 text-[11px] text-text-tertiary">{statusLabel[goal.config.status]}</span>
              </div>
              <div className="mt-1 truncate text-xs text-text-tertiary">{goal.config.engineId} · {goal.config.interval}</div>
            </button>
          ))}
        </section>

        {selectedGoal && (
          <section className="mt-4 space-y-3">
            <div className="rounded-md border border-border-subtle bg-background-surface p-3">
              <div className="text-sm font-medium text-text-primary">{selectedGoal.config.title}</div>
              <div className="mt-1 text-xs text-text-tertiary">
                {statusLabel[selectedGoal.config.status]} · {selectedGoal.config.phase} · rev {selectedGoal.config.revision}
              </div>
              {selectedGoal.config.currentSessionId && (
                <div className="mt-1 truncate text-xs text-text-tertiary">
                  当前会话: {selectedGoal.config.currentSessionId}
                </div>
              )}
              <p className="mt-2 whitespace-pre-wrap text-sm text-text-secondary">{selectedGoal.config.goal}</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button type="button" onClick={handlePlanningSession} disabled={loading} className="inline-flex items-center justify-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5 text-xs text-primary hover:bg-primary/15 disabled:opacity-50">
                  <Send size={13} /> 规划会话
                </button>
                <button type="button" onClick={handleExecutionSession} disabled={loading} className="inline-flex items-center justify-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5 text-xs text-primary hover:bg-primary/15 disabled:opacity-50">
                  <Send size={13} /> 执行会话
                </button>
                <button type="button" onClick={handleMaintenanceSession} disabled={loading} className="inline-flex items-center justify-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5 text-xs text-primary hover:bg-primary/15 disabled:opacity-50">
                  <Send size={13} /> 维护会话
                </button>
                {selectedGoal.config.currentSessionId && (
                  <button type="button" onClick={handleInterruptCurrentSession} disabled={loading} className="inline-flex items-center justify-center gap-1 rounded-md border border-danger/30 bg-danger-faint px-2 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-50">
                    <Square size={13} /> 中断会话
                  </button>
                )}
                <button type="button" onClick={handlePause} disabled={loading} className="inline-flex items-center justify-center gap-1 rounded-md border border-border-subtle px-2 py-1.5 text-xs text-text-secondary hover:bg-background-hover disabled:opacity-50">
                  <Pause size={13} /> 暂停
                </button>
                <button type="button" onClick={handleResume} disabled={loading} className="inline-flex items-center justify-center gap-1 rounded-md border border-border-subtle px-2 py-1.5 text-xs text-text-secondary hover:bg-background-hover disabled:opacity-50">
                  <Play size={13} /> 恢复
                </button>
                <button type="button" onClick={handleMaintenance} disabled={loading} className="inline-flex items-center justify-center gap-1 rounded-md border border-border-subtle px-2 py-1.5 text-xs text-text-secondary hover:bg-background-hover disabled:opacity-50">
                  <Wrench size={13} /> 维护
                </button>
                <button type="button" onClick={handleComplete} disabled={loading} className="inline-flex items-center justify-center gap-1 rounded-md border border-border-subtle px-2 py-1.5 text-xs text-text-secondary hover:bg-background-hover disabled:opacity-50">
                  <CheckCircle2 size={13} /> 完成
                </button>
              </div>
            </div>

            <div className="rounded-md border border-border-subtle bg-background-surface p-3">
              <div className="text-xs font-medium text-text-secondary">用户补充</div>
              <textarea
                value={supplement}
                onChange={(event) => setSupplement(event.target.value)}
                rows={3}
                className="mt-2 w-full resize-none rounded-md border border-border-subtle bg-background-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
                placeholder="追加给下一次会话读取的补充"
              />
              <button
                type="button"
                onClick={handleAppendSupplement}
                disabled={loading || !supplement.trim()}
                className="mt-2 rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-background-hover disabled:opacity-50"
              >
                追加补充
              </button>
            </div>

            <DocumentPreview title="进度" content={selectedGoal.documents.progress} />
            <DocumentPreview title="任务队列" content={selectedGoal.documents.queue} />
            {maintenancePrompt && <DocumentPreview title="维护会话输入" content={maintenancePrompt} />}
          </section>
        )}
      </div>
    </div>
  )
}

function DocumentPreview({ title, content }: { title: string; content: string }) {
  return (
    <details className="rounded-md border border-border-subtle bg-background-surface">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-secondary">{title}</summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-3 pb-3 text-xs text-text-tertiary">{content}</pre>
    </details>
  )
}
