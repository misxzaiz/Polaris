/**
 * AI-2 原子提交 · 分组方案卡片
 *
 * 本地预检分组 → 分组卡片 → 逐组勾选确认 → 按组原子提交。
 * 对齐 prototype #atomiccard：组行（checkbox + 拟 message + 文件集 + 置信徽标）+ 确认/调整按钮。
 *
 * 设计要点：
 * - 预检是纯前端确定性计算（gitAtomicGrouping），AI 只在「调整分组」时解释低置信组
 * - 逐组确认：每组独立 checkbox；执行时仅勾选组按序 commitGroup（后端隔离语义）
 * - 「✦ 调整分组」打开 git-atomic 会话投喂低置信组；回流建议仅提示，不改预检结果
 */

import { useMemo, useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { GitCommit, Sparkles, Loader2 } from 'lucide-react'
import {
  groupChangesForAtomicCommit,
  mergeChangeViews,
  type AtomicCommitGroup,
} from '@/services/gitAtomicGrouping'
import { openAtomicCommitChat, useAtomicCommitSuggestion } from '@/services/atomicCommitChat'
import { useGitStore } from '@/stores/gitStore/index'
import { useConfigStore } from '@/stores/configStore'
import { normalizeEngineId } from '@/utils/engineDisplay'
import type { GitDiffEntry, GitFileChange } from '@/types/git'

interface AtomicCommitCardProps {
  workspacePath: string
  workspaceId: string | null | undefined
  indexChanges: GitFileChange[]
  worktreeChanges: GitFileChange[]
  untracked: string[]
  onCommitGroup: (files: string[], message: string) => Promise<void>
  disabled?: boolean
}

export function AtomicCommitCard({
  workspacePath,
  workspaceId,
  indexChanges,
  worktreeChanges,
  untracked,
  onCommitGroup,
  disabled = false,
}: AtomicCommitCardProps) {
  const { t } = useTranslation('git')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [isExecuting, setIsExecuting] = useState(false)
  const [isAdjusting, setIsAdjusting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 默认引擎（低置信组「调整分组」投喂 git-atomic 会话用）
  const defaultEngine = normalizeEngineId(useConfigStore((s) => s.config?.defaultEngine))

  // 低置信组投喂 AI 时现取统一 diff（worktree + index）
  const worktreeDiffs = useGitStore((s) => s.worktreeDiffsByWs?.[workspacePath])
  const indexDiffs = useGitStore((s) => s.indexDiffsByWs?.[workspacePath])

  // 本地预检分组（纯函数，输入变更 → 分组方案）
  const groups = useMemo<AtomicCommitGroup[]>(() => {
    const merged = mergeChangeViews(indexChanges, worktreeChanges, untracked)
    return groupChangesForAtomicCommit(merged)
  }, [indexChanges, worktreeChanges, untracked])

  // 回流建议（git-atomic 会话最新消息）
  const suggestion = useAtomicCommitSuggestion(workspaceId)

  // 首次渲染默认全选（对齐 prototype：checkbox 默认 checked）；分组变化时保持选中态
  useEffect(() => {
    if (groups.length > 0 && checked.size === 0) {
      setChecked(new Set(groups.map((g) => g.id)))
    }
  }, [groups, checked.size])

  const toggleGroup = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const checkedGroups = groups.filter((g) => checked.has(g.id))
  const hasLowConfidence = groups.some((g) => g.confidence === 'low')

  const handleExecute = async () => {
    if (checkedGroups.length === 0) return
    setIsExecuting(true)
    setError(null)
    try {
      for (const g of checkedGroups) {
        await onCommitGroup(g.files.map((f) => f.path), g.message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsExecuting(false)
    }
  }

  const handleAdjust = async () => {
    if (!workspaceId) return
    setIsAdjusting(true)
    setError(null)
    try {
      // 统一 diff 视图：index 优先、worktree 补（低置信组文件内容供 AI 判断）
      const byPath = new Map<string, GitDiffEntry>()
      for (const d of indexDiffs ?? []) byPath.set(d.file_path, d)
      for (const d of worktreeDiffs ?? []) {
        if (!byPath.has(d.file_path)) byPath.set(d.file_path, d)
      }
      const allDiffs = Array.from(byPath.values())
      await openAtomicCommitChat({
        workspaceId,
        workspacePath,
        engineId: defaultEngine,
        groups,
        diffs: allDiffs,
        lowConfidenceOnly: true,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsAdjusting(false)
    }
  }

  if (groups.length === 0) return null

  return (
    <div className="atomic-commit-card" data-testid="atomic-commit-card">
      <div className="atomic-card-header">
        <Sparkles size={14} />
        <span>{t('atomic.title')}</span>
        <span className="atomic-eng">{t('atomic.engineHint')}</span>
      </div>

      <div className="atomic-group-list">
        {groups.map((g) => (
          <div key={g.id} className={`atomic-group${g.confidence === 'low' ? ' low' : ''}`}>
            <label className="atomic-group-check">
              <input
                type="checkbox"
                checked={checked.has(g.id)}
                onChange={() => toggleGroup(g.id)}
                disabled={disabled || isExecuting}
              />
              <span className="atomic-group-msg">{g.message}</span>
              <span className={`atomic-conf ${g.confidence}`}>
                {g.confidence === 'low' ? t('atomic.lowConfidence') : t('atomic.highConfidence')}
              </span>
            </label>
            <div className="atomic-group-files">
              {g.files.map((f) => f.path).join(' · ')}
            </div>
            <div className="atomic-group-reason">{g.reason}</div>
          </div>
        ))}
      </div>

      <div className="atomic-actions">
        <button
          className="btn primary"
          disabled={checkedGroups.length === 0 || isExecuting || disabled}
          onClick={handleExecute}
        >
          {isExecuting ? <Loader2 size={14} className="spin" /> : <GitCommit size={14} />}
          {t('atomic.commitGroups', { count: checkedGroups.length })}
        </button>
        <button
          className="btn ghost"
          onClick={handleAdjust}
          disabled={disabled || isAdjusting || !hasLowConfidence}
          title={hasLowConfidence ? t('atomic.adjustHint') : undefined}
        >
          {isAdjusting ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
          {t('atomic.adjust')}
        </button>
      </div>

      {suggestion.text && !suggestion.isStreaming && (
        <div className="atomic-suggestion">
          <div className="atomic-suggestion-label">{t('atomic.suggestion')}</div>
          <div className="atomic-suggestion-body">{suggestion.text}</div>
        </div>
      )}

      {error && <div className="atomic-error">{error}</div>}
    </div>
  )
}