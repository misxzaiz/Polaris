/**
 * 三窗合并编辑器（P3 FR-P3-1 重写版：同源 regions 对位真三窗）
 *
 * 布局核心（vs 旧版）：
 *   旧版 = ours/theirs 全文 `<pre>` ×2 + 底部 hunk 卡片 ×N（同一内容渲染两遍、
 *   窗与卡片不对位，大文件信息重影）。
 *   新版 = **一次解析、三列同渲染**：`regions` 数组逐行驱动三列 grid——
 *   每个区域在左（ours）/中（result）/右（theirs）占同一行位，天然对位；
 *   冲突区域的中列就地提供 [Accept Ours | Theirs | Base] 决策控件（VS Code 式），
 *   决策后中列实时重渲染为所选侧内容。
 *
 * 交互：
 * - per-hunk 决策（resolutions 驱动 buildResult 拼合）
 * - Apply All：**真实现**——剩余未决策冲突块批量采纳为本方（ours；parse 层
 *   已吸收非重叠单侧改动，剩余块均为双侧非空的重叠冲突）
 * - 跳到下一个未解决块（scrollIntoView）
 * - 手动编辑接管中列
 * - 完成 → git_resolve_conflict_file（写内容 + add 直落 staging）→ onResolved
 */

import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CheckCheck, ArrowDown, FileCode, Loader2, Pencil, X } from 'lucide-react'
import { parseConflictMarkers, buildResult, countUnresolved } from './parseConflictMarkers'
import type { ConflictResolution, MergeRegion, ConflictHunk } from './parseConflictMarkers'
import type { GitConflictEntry, GitSequenceKind } from '@/types/git'
import { useGitStore } from '@/stores/gitStore/index'
import { useToastStore } from '@/stores/toastStore'

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

/** 冲突区域三列内容：左（ours）/ 中（result 当前态）/ 右（theirs） */
interface RegionCells {
  left: string[]
  right: string[]
}

function regionDisplayLines(region: MergeRegion): RegionCells {
  if (region.kind === 'conflict') {
    return {
      left: region.oursLines ?? [],
      right: region.theirsLines ?? [],
    }
  }
  return { left: region.lines, right: region.lines }
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
  const resolveConflictFile = useGitStore((s) => s.resolveConflictFile)

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

  // conflict 区域 ↔ hunk 对齐（按 base 区间配对；hunk.id 即 resolutions 键）
  const hunkByRegion = useMemo(() => {
    const map = new Map<MergeRegion, ConflictHunk>()
    const byBase = new Map<string, ConflictHunk>()
    hunks.forEach((h) => byBase.set(`${h.baseStart}:${h.baseEnd}`, h))
    let fallbackIdx = 0
    for (const region of regions) {
      if (region.kind !== 'conflict') continue
      const hit = byBase.get(`${region.baseStart}:${region.baseEnd}`)
      map.set(region, hit ?? hunks[fallbackIdx])
      fallbackIdx++
    }
    return map
  }, [regions, hunks])

  // 未解决冲突区域列表（跳转到下个用）
  const unresolvedRegions = useMemo(
    () => regions.filter((r) => r.kind === 'conflict' && !isResolved(r)),
    // eslint 需要显式依赖 resolutions：
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [regions, resolutions],
  )
  function isResolved(region: MergeRegion): boolean {
    const hunk = hunkByRegion.get(region)
    return hunk ? resolutions[hunk.id] !== undefined : true
  }

  // 跳到下一个未解决块
  const scrollTargetRef = useRef<HTMLDivElement | null>(null)
  const scrollToFirstUnresolved = () => {
    const el = scrollTargetRef.current
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  function setResolution(id: number, side: ConflictResolution) {
    setResolutions((prev) => ({ ...prev, [id]: side }))
  }

  /** 批量决策（Apply All 消费；一枚 setState 内合并） */
  function setResolutionMany(ids: number[], side: ConflictResolution) {
    setResolutions((prev) => {
      const next = { ...prev }
      for (const id of ids) next[id] = side
      return next
    })
  }

  // 结果（手动编辑优先；否则按决策拼合）
  const resultContent = useMemo(() => {
    if (manualResult !== null) return manualResult
    return buildResult(regions, resolutions)
  }, [regions, resolutions, manualResult])

  /**
   * Apply All（真实现）：把所有**未决策**的冲突块批量采纳为本方（ours）。
   * 注：parse 层已把非重叠的单侧改动直接吸收进结果（kind=ours/theirs 区），
   * 剩余 conflict 块都是双侧非空的重叠冲突——「批量取本方」是唯一的确定性
   * 批量语义；逐块精确决策仍在中列完成。旧版此按钮只弹 toast、不改状态（假按钮）。
   */
  const applyAll = () => {
    const pendingIds = hunks.filter((h) => resolutions[h.id] === undefined).map((h) => h.id)
    if (pendingIds.length === 0) {
      toast.info(t('conflict.applyAllNothing'))
      return
    }
    setResolutionMany(pendingIds, 'ours')
    toast.success(t('conflict.applyAllResolved', { count: pendingIds.length }))
  }

  // 语义标签：current/incoming 方向（merge → 左 current 右 incoming；其余反）
  const isCurrentLeft = sequenceKind === 'merge'
  const leftLabel = isCurrentLeft ? t('conflict.current') : t('conflict.incoming')
  const rightLabel = isCurrentLeft ? t('conflict.incoming') : t('conflict.current')

  async function handleResolve() {
    setIsSaving(true)
    try {
      await resolveConflictFile(workspacePath, conflict.path, resultContent)
      toast.success(t('conflict.resolvedSuccess', { file: conflict.path }))
      onResolved(conflict.path)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onError?.(msg)
    } finally {
      setIsSaving(false)
    }
  }

  /** 冲突区域中列：决策后的实时结果行（未决 = pending 提示） */
  function resolvedLines(hunk: ConflictHunk): string[] {
    switch (resolutions[hunk.id]) {
      case 'ours':
        return hunk.oursLines
      case 'theirs':
        return hunk.theirsLines
      case 'base':
        return hunk.baseLines
      default:
        return []
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="three-way-editor">
      {/* 顶栏：文件 + 计数 + Apply All + 跳到下一未解决 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-background-surface">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode size={14} className="text-text-tertiary shrink-0" />
          <span className="text-sm text-text-primary font-medium truncate" title={conflict.path}>
            {conflict.path}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {unresolved > 0 ? (
            <span className="text-xs px-2 py-0.5 rounded-full bg-danger/10 text-danger" data-testid="unresolved-count">
              {t('conflict.unresolved', { count: unresolved })}
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded-full bg-success/10 text-success" data-testid="all-resolved-count">
              {t('conflict.allResolved')}
            </span>
          )}
          {unresolved > 0 && (
            <button
              className="text-xs px-2 py-1 rounded border border-border text-text-secondary hover:bg-background-hover transition-colors"
              onClick={scrollToFirstUnresolved}
              title={t('conflict.nextBlock')}
              data-testid="next-block"
            >
              <ArrowDown size={12} className="inline mr-1" />
              {t('conflict.nextBlock')}
            </button>
          )}
          <button
            className="text-xs px-2.5 py-1 rounded border border-border text-text-secondary hover:bg-background-hover transition-colors"
            onClick={applyAll}
            title={t('conflict.applyAllTitle')}
            data-testid="apply-all"
          >
            <CheckCheck size={14} className="inline mr-1" />
            {t('conflict.applyAll')}
          </button>
        </div>
      </div>

      {/* 无文本冲突块提示（binary / 单侧改动已在 parse 吸收，无需决策） */}
      {hunks.length === 0 && (
        <div
          className="px-4 py-2 text-xs text-text-tertiary bg-background-surface border-b border-border"
          data-testid="no-blocks"
        >
          {t('conflict.noBlocks')}
        </div>
      )}

      {/* 三窗：同一 regions 数组驱动三列，逐区域对位 */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="grid grid-cols-3 gap-px bg-border" data-testid="merge-regions">
          {/* 表头 */}
          <div className="px-3 py-1.5 text-xs font-medium bg-background-surface flex items-center gap-1">
            <span className={isCurrentLeft ? 'text-primary' : 'text-warning'}>◉</span>
            {leftLabel}
            <span className="text-text-tertiary ml-auto">{t('conflict.ours')}</span>
          </div>
          <div className="px-3 py-1.5 text-xs font-medium bg-background-surface flex items-center gap-1">
            <span className="text-success">◉</span>
            {t('conflict.result')}
          </div>
          <div className="px-3 py-1.5 text-xs font-medium bg-background-surface flex items-center gap-1">
            <span className={!isCurrentLeft ? 'text-primary' : 'text-warning'}>◉</span>
            {rightLabel}
            <span className="text-text-tertiary ml-auto">{t('conflict.theirs')}</span>
          </div>

          {regions.map((region, i) => {
            const cells = regionDisplayLines(region)
            const hunk = hunkByRegion.get(region)

            if (region.kind === 'conflict' && hunk) {
              const firstUnresolved = unresolvedRegions[0] === region
              const resultLines = resolvedLines(hunk)
              return (
                <div
                  key={`${region.baseStart}-${region.baseEnd}-${i}`}
                  ref={firstUnresolved ? scrollTargetRef : undefined}
                  className="contents"
                  data-testid={`hunk-${hunk.id}`}
                >
                  {/* 左：ours 行 */}
                  <div className="bg-background-elevated min-h-[28px]">
                    <pre className="px-3 py-1 text-xs leading-5 font-mono whitespace-pre text-text-secondary">
                      {region.oursLines?.join('\n') || t('conflict.empty')}
                    </pre>
                  </div>
                  {/* 中：决策 + 实时结果 */}
                  <div
                    className={`bg-background-elevated min-h-[28px] ${
                      resolutions[hunk.id] ? 'bg-success/5' : 'bg-warning/5'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 px-3 py-1 border-b border-border/50">
                      <span
                        className={`text-xs font-medium shrink-0 ${
                          resolutions[hunk.id] ? 'text-success' : 'text-danger'
                        }`}
                      >
                        {resolutions[hunk.id] ? '✓' : '⚠'} {t('conflict.block')} {hunk.id + 1}
                      </span>
                      {resolutions[hunk.id] ? (
                        <button
                          className="ml-auto text-text-tertiary hover:text-text-primary p-0.5"
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
                      ) : (
                        <span className="ml-auto flex gap-1">
                          <button
                            className="text-xs px-1.5 py-0.5 rounded border border-primary/30 text-primary hover:bg-primary/10"
                            onClick={() => setResolution(hunk.id, 'ours')}
                            data-testid={`accept-ours-${hunk.id}`}
                          >
                            {t('conflict.acceptOurs')}
                          </button>
                          <button
                            className="text-xs px-1.5 py-0.5 rounded border border-warning/30 text-warning hover:bg-warning/10"
                            onClick={() => setResolution(hunk.id, 'theirs')}
                            data-testid={`accept-theirs-${hunk.id}`}
                          >
                            {t('conflict.acceptTheirs')}
                          </button>
                          <button
                            className="text-xs px-1.5 py-0.5 rounded border border-border text-text-secondary hover:bg-background-hover"
                            onClick={() => setResolution(hunk.id, 'base')}
                            data-testid={`accept-base-${hunk.id}`}
                          >
                            {t('conflict.acceptBase')}
                          </button>
                        </span>
                      )}
                    </div>
                    <pre className="px-3 py-1 text-xs leading-5 font-mono whitespace-pre text-text-primary">
                      {resultLines.length > 0
                        ? resultLines.join('\n')
                        : <span className="text-text-tertiary">{t('conflict.pendingDecision')}</span>}
                    </pre>
                  </div>
                  {/* 右：theirs 行 */}
                  <div className="bg-background-elevated min-h-[28px]">
                    <pre className="px-3 py-1 text-xs leading-5 font-mono whitespace-pre text-text-secondary">
                      {region.theirsLines?.join('\n') || t('conflict.empty')}
                    </pre>
                  </div>
                </div>
              )
            }

            // 非冲突区域（common/ours/theirs）：三列同一/单侧内容，中列只读（已吸收进结果）
            return (
              <div key={`${region.baseStart}-${region.baseEnd}-${i}`} className="contents" data-region-kind={region.kind}>
                <div className="bg-background min-h-[20px]">
                  <pre className="px-3 py-0.5 text-xs leading-5 font-mono whitespace-pre text-text-tertiary">
                    {cells.left.join('\n') || ' '}
                  </pre>
                </div>
                <div className="bg-background-elevated/50 min-h-[20px]">
                  <pre className="px-3 py-0.5 text-xs leading-5 font-mono whitespace-pre text-text-secondary/80">
                    {cells.left.join('\n') || ' '}
                  </pre>
                </div>
                <div className="bg-background min-h-[20px]">
                  <pre className="px-3 py-0.5 text-xs leading-5 font-mono whitespace-pre text-text-tertiary">
                    {cells.right.join('\n') || ' '}
                  </pre>
                </div>
              </div>
            )
          })}
        </div>
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

      {/* 手动编辑接管：覆盖层（保持中列可感知） */}
      {manualResult !== null && (
        <div className="px-4 py-2 bg-background-surface border-t border-border">
          <textarea
            className="w-full text-xs leading-5 font-mono bg-background-elevated text-text-primary resize-none outline-none focus:ring-1 focus:ring-primary/40 h-32"
            value={manualResult}
            onChange={(e) => setManualResult(e.target.value)}
            spellCheck={false}
            data-testid="manual-result"
          />
          <div className="flex justify-end mt-1">
            <button
              className="text-xs text-text-tertiary hover:text-text-primary"
              onClick={() => setManualResult(null)}
              data-testid="manual-exit"
            >
              <Pencil size={12} className="inline mr-1" />
              {t('conflict.manualExit')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
