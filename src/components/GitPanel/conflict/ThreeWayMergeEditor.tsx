/**
 * 三窗合并编辑器（P3 FR-P3-1：per-hunk 控件 + 计数 + 直落 staging）
 *
 * 布局对齐 VS Code Merge Editor：
 *   左窗 ours（current/incoming 按 kind 决定）｜ 中窗 result（可编辑）｜ 右窗 theirs
 *
 * 交互：
 * - 每冲突块 Accept Ours / Accept Theirs / Accept Base（decision 驱动 result 拼合）
 * - Apply All Non-Conflicting：一键把非冲突单侧改动全部纳入 result
 * - 未解决计数常驻顶栏；归零点亮「完成并暂存」
 * - 完成 → git_resolve_conflict_file（写内容 + git add，直落 staging）→ onResolved 回调
 *
 * 数据流：
 *   parseConflictMarkers(base/ours/theirs) → regions + conflicts
 *   resolutions: { conflictId → 'ours' | 'theirs' | 'base' }（未设 = 未解决）
 *   buildResult(regions, resolutions) → result 预览（或手动编辑 textarea 接管）
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CheckCheck, FileCode, Loader2, Pencil, X } from 'lucide-react'
import { parseConflictMarkers, buildResult, countUnresolved } from './parseConflictMarkers'
import type { ConflictResolution, MergeRegion, ConflictHunk } from './parseConflictMarkers'
import type { GitConflictEntry, GitSequenceKind } from '@/types/git'
import { useGitStore } from '@/stores/gitStore/index'
import { useToastStore } from '@/stores/toastStore'
import { invoke } from '@/services/transport'

interface ThreeWayMergeEditorProps {
  workspacePath: string
  conflict: GitConflictEntry
  /** 序列操作类型，决定 current/incoming 语义标签 */
  sequenceKind: GitSequenceKind
  /** 已解决的此文件路径（父级维护当前文件指针） */
  onResolved: (path: string) => void
  /** 失败/取消上报 */
  onError?: (message: string) => void
}

export function ThreeWayMergeEditor({
  workspacePath,
  conflict,
  sequenceKind,
  onResolved,
  onError,
}: ThreeWayMergeEditorProps) {
  const { t } = useTranslation('git')
  const toast = useToastStore()
  const getConflictState = useGitStore((s) => s.getConflictState)

  // 解析
  const parse = useMemo(
    () => parseConflictMarkers(conflict.base ?? null, conflict.ours ?? null, conflict.theirs ?? null),
    [conflict.base, conflict.ours, conflict.theirs],
  )
  const regions: MergeRegion[] = parse.regions
  const hunks: ConflictHunk[] = parse.conflicts

  // 决策状态
  const [resolutions, setResolutions] = useState<Record<number, ConflictResolution>>({})
  const [manualResult, setManualResult] = useState<string | null>(null) // 用户手动编辑接管
  const [isSaving, setIsSaving] = useState(false)

  const unresolved = useMemo(
    () => (manualResult !== null ? 0 : countUnresolved(resolutions, hunks.length)),
    [resolutions, hunks.length, manualResult],
  )
  const resolvedCount = hunks.length - unresolved
  const hasNonConflictingRegions = useMemo(
    () => regions.some((r) => r.kind === 'ours' || r.kind === 'theirs'),
    [regions],
  )

  function hasResolved(id: number): boolean {
    return resolutions[id] !== undefined
  }
  function setResolution(id: number, side: ConflictResolution) {
    setResolutions((prev) => ({ ...prev, [id]: side }))
  }

  // 结果预览（手动编辑优先；否则按决策拼合）
  const resultContent = useMemo(() => {
    if (manualResult !== null) return manualResult
    return buildResult(regions, resolutions)
  }, [regions, resolutions, manualResult])

  // Apply All Non-Conflicting：buildResult 天然已把 common/ours/theirs 采纳，
  // 冲突块需显式决策。此按钮提供一次性反馈并提示已合入的非冲突区域。
  const applyAllNonConflicting = () => {
    if (resolvedCount === hunks.length && hunks.length > 0) {
      toast.success(t('conflict.applyAllAlreadyDone'))
      return
    }
    toast.info(t('conflict.applyAllMerged'))
  }

  // 语义标签：current/incoming 方向（merge → 左 current 右 incoming；其余反）
  const isCurrentLeft = sequenceKind === 'merge'
  const leftLabel = isCurrentLeft ? t('conflict.current') : t('conflict.incoming')
  const rightLabel = isCurrentLeft ? t('conflict.incoming') : t('conflict.current')

  async function handleResolve() {
    setIsSaving(true)
    try {
      await invoke('git_resolve_conflict_file', {
        workspacePath,
        filePath: conflict.path,
        content: resultContent,
      })
      await getConflictState(workspacePath)
      toast.success(t('conflict.resolvedSuccess', { file: conflict.path }))
      onResolved(conflict.path)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onError?.(msg)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="three-way-editor">
      {/* 顶栏：文件 + 计数 + Apply All */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-background-surface">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode size={14} className="text-text-tertiary shrink-0" />
          <span className="text-sm text-text-primary font-medium truncate" title={conflict.path}>
            {conflict.path}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {unresolved > 0 ? (
            <span className="text-xs px-2 py-0.5 rounded-full bg-danger/10 text-danger">
              {t('conflict.unresolved', { count: unresolved })}
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded-full bg-success/10 text-success">
              {t('conflict.allResolved')}
            </span>
          )}
          <button
            className="text-xs px-2.5 py-1 rounded border border-border text-text-secondary hover:bg-background-hover transition-colors disabled:opacity-40"
            disabled={!hasNonConflictingRegions}
            onClick={applyAllNonConflicting}
            title={t('conflict.applyAllTitle')}
            data-testid="apply-all"
          >
            <CheckCheck size={14} className="inline mr-1" />
            {t('conflict.applyAll')}
          </button>
        </div>
      </div>

      {/* 三窗 */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="grid grid-cols-3 gap-px bg-border">
          {/* 左窗 ours */}
          <div className="bg-background-elevated flex flex-col min-h-[140px]">
            <div className="px-3 py-1.5 text-xs font-medium border-b border-border bg-background-surface flex items-center gap-1">
              <span className={isCurrentLeft ? 'text-primary' : 'text-warning'}>◉</span>
              {leftLabel}
              <span className="text-text-tertiary ml-auto">{t('conflict.ours')}</span>
            </div>
            <pre className="px-3 py-2 text-xs leading-5 font-mono text-text-secondary whitespace-pre-wrap flex-1 overflow-auto max-h-64">
              {conflict.ours ?? ''}
            </pre>
          </div>
          {/* 中窗 result */}
          <div className="bg-background-elevated flex flex-col min-h-[140px]">
            <div className="px-3 py-1.5 text-xs font-medium border-b border-border bg-background-surface flex items-center gap-1">
              <span className="text-success">◉</span>
              {t('conflict.result')}
            </div>
            {manualResult === null ? (
              <pre className="px-3 py-2 text-xs leading-5 font-mono text-text-primary whitespace-pre-wrap flex-1 overflow-auto max-h-64">
                {resultContent || ' '}
              </pre>
            ) : (
              <textarea
                className="w-full flex-1 px-3 py-2 text-xs leading-5 font-mono bg-background-elevated text-text-primary resize-none outline-none focus:ring-1 focus:ring-primary/40 min-h-[100px] max-h-64"
                value={manualResult}
                onChange={(e) => setManualResult(e.target.value)}
                spellCheck={false}
                data-testid="manual-result"
              />
            )}
          </div>
          {/* 右窗 theirs */}
          <div className="bg-background-elevated flex flex-col min-h-[140px]">
            <div className="px-3 py-1.5 text-xs font-medium border-b border-border bg-background-surface flex items-center gap-1">
              <span className={!isCurrentLeft ? 'text-primary' : 'text-warning'}>◉</span>
              {rightLabel}
              <span className="text-text-tertiary ml-auto">{t('conflict.theirs')}</span>
            </div>
            <pre className="px-3 py-2 text-xs leading-5 font-mono text-text-secondary whitespace-pre-wrap flex-1 overflow-auto max-h-64">
              {conflict.theirs ?? ''}
            </pre>
          </div>
        </div>

        {/* per-hunk 控件 */}
        {hunks.length > 0 && (
          <div className="px-4 py-3 space-y-2">
            <div className="text-xs text-text-tertiary mb-2">
              {t('conflict.conflictBlocks', { done: resolvedCount, total: hunks.length })}
              <span className="ml-2 text-text-tertiary/70">{t('conflict.hint')}</span>
            </div>
            {hunks.map((hunk) => (
              <div
                key={hunk.id}
                className="border rounded-md border-border bg-background-surface"
                data-testid={`hunk-${hunk.id}`}
              >
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background-hover/40">
                  <span
                    className={`text-xs font-medium ${hasResolved(hunk.id) ? 'text-success' : 'text-danger'}`}
                  >
                    {hasResolved(hunk.id) ? '✓' : '⚠'} {t('conflict.block')} {hunk.id + 1}
                  </span>
                  <span className="text-xs text-text-tertiary ml-auto">
                    L{hunk.startLine + 1}–{hunk.endLine}
                  </span>
                  <button
                    className="text-xs px-2 py-0.5 rounded border border-primary/30 text-primary hover:bg-primary/10 transition-colors"
                    onClick={() => setResolution(hunk.id, 'ours')}
                    data-testid={`accept-ours-${hunk.id}`}
                  >
                    {t('conflict.acceptOurs')}
                  </button>
                  <button
                    className="text-xs px-2 py-0.5 rounded border border-warning/30 text-warning hover:bg-warning/10 transition-colors"
                    onClick={() => setResolution(hunk.id, 'theirs')}
                    data-testid={`accept-theirs-${hunk.id}`}
                  >
                    {t('conflict.acceptTheirs')}
                  </button>
                  <button
                    className="text-xs px-2 py-0.5 rounded border border-border text-text-secondary hover:bg-background-hover transition-colors"
                    onClick={() => setResolution(hunk.id, 'base')}
                    data-testid={`accept-base-${hunk.id}`}
                  >
                    {t('conflict.acceptBase')}
                  </button>
                  {hasResolved(hunk.id) && (
                    <button
                      className="text-xs px-1.5 text-text-tertiary hover:text-text-primary"
                      title={t('conflict.undo')}
                      onClick={() =>
                        setResolutions((prev) => {
                          const next = { ...prev }
                          delete next[hunk.id]
                          return next
                        })
                      }
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-px bg-border">
                  <pre className="px-3 py-2 text-xs leading-5 font-mono whitespace-pre overflow-x-auto text-text-secondary bg-background-elevated max-h-40 overflow-y-auto">
                    {hunk.oursLines.join('\n') || t('conflict.empty')}
                  </pre>
                  <pre className="px-3 py-2 text-xs leading-5 font-mono whitespace-pre overflow-x-auto text-text-secondary bg-background-elevated max-h-40 overflow-y-auto">
                    {hunk.theirsLines.join('\n') || t('conflict.empty')}
                  </pre>
                </div>
              </div>
            ))}
          </div>
        )}

        {hunks.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-text-secondary">
            {t('conflict.noBlocks')}
          </div>
        )}
      </div>

      {/* 底栏：手动编辑 + 完成并暂存 */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-background-surface">
        <button
          className="text-xs px-2.5 py-1 rounded border border-border text-text-secondary hover:bg-background-hover transition-colors flex items-center gap-1"
          onClick={() => setManualResult(buildResult(regions, resolutions))}
          title={t('conflict.manualEditTitle')}
          data-testid="manual-edit"
        >
          <Pencil size={12} />
          {t('conflict.manualEdit')}
        </button>
        <div className="flex items-center gap-2">
          <button
            className="text-xs px-3 py-1.5 rounded text-text-secondary border border-border hover:bg-background-hover transition-colors"
            onClick={() => onError?.('cancelled')}
          >
            {t('common.cancel')}
          </button>
          <button
            className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center gap-1"
            disabled={unresolved > 0 || isSaving}
            onClick={handleResolve}
            data-testid="resolve-done"
          >
            {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {t('conflict.doneStage')}
          </button>
        </div>
      </div>
    </div>
  )
}