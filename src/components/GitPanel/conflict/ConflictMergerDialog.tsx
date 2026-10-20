/**
 * 冲突合并对话框（P3 FR-P3-1：文件级编排）
 *
 * 两形态：
 * 1. 文件列表形态：每文件按 kind 提供正确语义的快捷操作——
 *    - text → 手动进三窗编辑器
 *    - binary / rename_delete → 还原某侧 stage（side）
 *    - deleted_by_them（对方删·本地改）→「保留本地修改」= side:ours /「接受删除」= remove
 *    - deleted_by_us（本地删·对方改）→「接受删除」= remove /「保留对方修改」= side:theirs
 *    + Resolve All Simple 一键（全部非 Text 自动取本方，删类走对应 true 语义）
 * 2. 编辑器形态：选中 Text 文件 → 内嵌 ThreeWayMergeEditor（per-hunk 决策 → 直落 staging）
 *
 * 流转（旧版时机缺陷已修）：
 * - 解决任一文件后以 getConflictState 的**新鲜返回值**决定下一步（不读旧 props）；
 * - 剩余 Text 文件自动接力进编辑器；
 * - 全部归零 → 非 merge 序列操作给出 Continue/Abort 引导，merge 提示去提交。
 *
 * 数据源：`GitSequenceState`（store.getConflictState）。
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, CheckCheck, FileCode, Loader2, X } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useToastStore } from '@/stores/toastStore'
import { ThreeWayMergeEditor } from './ThreeWayMergeEditor'
import type { GitSequenceState, GitConflictEntry, GitConflictKind, GitSequenceKind } from '@/types/git'

interface ConflictMergerDialogProps {
  workspacePath: string
  sequence: GitSequenceState
  onClose: () => void
  /** 解决任何文件后刷新（父级重新拉 getConflictState + refreshStatus） */
  onRefresh: () => void
}

/** 简单解决的 kind：不需 per-hunk 编辑器，走文件级整取舍 */
function isSimpleKind(kind: GitConflictKind): boolean {
  return kind !== 'text'
}

/** 简单解决动作：kind + 侧 → 三态 resolve 动作（与后端三态契约对齐） */
type SimpleAction = { side: 'ours' | 'theirs' } | { remove: true }

function simpleResolveAction(entry: GitConflictEntry, side: 'ours' | 'theirs'): SimpleAction {
  // 对方删·本地改：本方=保留修改（stage2），对方=删除
  if (entry.kind === 'deleted_by_them') {
    return side === 'ours' ? { side: 'ours' } : { remove: true }
  }
  // 本地删·对方改：本方=删除，对方=保留对方修改（stage3）
  if (entry.kind === 'deleted_by_us') {
    return side === 'ours' ? { remove: true } : { side: 'theirs' }
  }
  // binary / rename_delete：按 stage 还原对应侧
  return { side }
}

export function ConflictMergerDialog({
  workspacePath,
  sequence,
  onClose,
  onRefresh,
}: ConflictMergerDialogProps) {
  const { t } = useTranslation('git')
  const toast = useToastStore()
  const closeMerger = useGitStore((s) => s.closeMerger)
  const getConflictState = useGitStore((s) => s.getConflictState)
  const removeConflictFile = useGitStore((s) => s.removeConflictFile)
  const checkoutConflictSide = useGitStore((s) => s.checkoutConflictSide)
  const rebaseContinue = useGitStore((s) => s.rebaseContinue)
  const rebaseAbort = useGitStore((s) => s.rebaseAbort)
  const cherryPickContinue = useGitStore((s) => s.cherryPickContinue)
  const cherryPickAbort = useGitStore((s) => s.cherryPickAbort)
  const revertContinue = useGitStore((s) => s.revertContinue)
  const revertAbort = useGitStore((s) => s.revertAbort)

  const conflicts = useMemo(() => sequence.conflicts ?? [], [sequence.conflicts])
  const [editingFile, setEditingFile] = useState<string | null>(null) // 当前进编辑器的文件
  const [solvingPath, setSolvingPath] = useState<string | null>(null) // 正在解决的文件
  const [busy, setBusy] = useState(false)
  const [actingKind, setActingKind] = useState<GitSequenceKind>(sequence.kind) // 收尾引导

  const editingConflict = editingFile
    ? conflicts.find((c) => c.path === editingFile) ?? null
    : null

  const textCount = conflicts.filter((c) => c.kind === 'text').length
  const simpleCount = conflicts.length - textCount

  const resolveSimple = async (entry: GitConflictEntry, side: 'ours' | 'theirs') => {
    if (solvingPath) return // 防并发
    setSolvingPath(entry.path)
    setBusy(true)
    try {
      const action = simpleResolveAction(entry, side)
      if ('remove' in action) {
        await removeConflictFile(workspacePath, entry.path)
      } else {
        await checkoutConflictSide(workspacePath, entry.path, action.side)
      }
      toast.success(t('conflict.fileResolved', { file: entry.path }))
      onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSolvingPath(null)
      setBusy(false)
    }
  }

  /** Resolve All Simple Conflicts：所有非 Text 自动取本方（删类走 true 删除语义），文本接力进编辑器 */
  const resolveAllSimple = async () => {
    if (busy) return
    setBusy(true)
    try {
      const simple = conflicts.filter((x) => isSimpleKind(x.kind))
      for (const entry of simple) {
        const action = simpleResolveAction(entry, 'ours')
        if ('remove' in action) {
          await removeConflictFile(workspacePath, entry.path)
        } else {
          await checkoutConflictSide(workspacePath, entry.path, action.side)
        }
      }
      if (simple.length > 0) toast.success(t('conflict.resolveAllDone'))
      onRefresh()
      // 文本冲突接力：以新鲜状态为准（旧实现读旧 props，会漏已被并行解决的文件）
      const fresh = (await getConflictState(workspacePath))?.conflicts ?? conflicts
      const nextText = fresh.find((x) => x.kind === 'text')
      if (nextText) setEditingFile(nextText.path)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** 编辑器解决后的流转：新鲜状态接力下一个 Text 文件，或按 kind 收尾 */
  const handleEditorResolved = async () => {
    setEditingFile(null)
    const fresh = await getConflictState(workspacePath)
    onRefresh()
    const remaining = fresh?.conflicts ?? []
    const nextText = remaining.find((c) => c.kind === 'text')
    if (nextText) {
      // 自动接力下一个未解决 Text 文件
      setEditingFile(nextText.path)
      return
    }
    if (remaining.length > 0) return // 只剩非 Text，回列表处理
    // 全部归零
    if (fresh && fresh.kind !== 'none') {
      setActingKind(fresh.kind)
      toast.success(t('conflict.allFilesDone'))
      return // 留在对话框给 Continue/Abort 引导
    }
    toast.success(t('conflict.allFilesDone'))
    closeMerger()
    onClose()
  }

  const handleEditorError = (msg: string) => {
    if (msg === 'cancelled') {
      setEditingFile(null)
      return
    }
    toast.error(msg)
  }

  /** 序列收尾（continue/abort）；调用方为 Dialog 收尾引导 */
  const doSequenceContinue = async () => {
    setBusy(true)
    try {
      if (actingKind === 'rebase') await rebaseContinue(workspacePath)
      else if (actingKind === 'cherry_pick') await cherryPickContinue(workspacePath)
      else if (actingKind === 'revert') await revertContinue(workspacePath)
      closeMerger()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      onRefresh()
    }
  }

  const doSequenceAbort = async () => {
    setBusy(true)
    try {
      if (actingKind === 'rebase') await rebaseAbort(workspacePath)
      else if (actingKind === 'cherry_pick') await cherryPickAbort(workspacePath)
      else if (actingKind === 'revert') await revertAbort(workspacePath)
      closeMerger()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      onRefresh()
    }
  }

  const conflictMap: Partial<Record<GitSequenceKind, { doContinue: () => Promise<void>; doAbort: () => Promise<void> }>> = {
    rebase: { doContinue: doSequenceContinue, doAbort: doSequenceAbort },
    cherry_pick: { doContinue: doSequenceContinue, doAbort: doSequenceAbort },
    revert: { doContinue: doSequenceContinue, doAbort: doSequenceAbort },
  }

  /** 按钮主文案（按 kind 换真实语义） */
  function simpleButtonLabel(entry: GitConflictEntry, side: 'ours' | 'theirs'): string {
    if (entry.kind === 'deleted_by_them') {
      return side === 'ours' ? t('conflict.keepLocalMod') : t('conflict.acceptDelete')
    }
    if (entry.kind === 'deleted_by_us') {
      return side === 'ours' ? t('conflict.acceptDelete') : t('conflict.keepTheirsMod')
    }
    return side === 'ours' ? t('conflict.acceptYours') : t('conflict.acceptTheirs')
  }

  // 编辑器形态
  if (editingConflict) {
    return (
      <div className="fixed inset-0 bg-black/50 z-modal flex items-center justify-center p-6">
        <div className="bg-background-elevated rounded-xl w-full max-w-5xl max-h-[86vh] flex flex-col shadow-lg border border-border">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <FileCode size={16} className="text-primary" />
              {t('conflict.editorTitle')}
            </h2>
            <button
              className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
              onClick={() => setEditingFile(null)}
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <ThreeWayMergeEditor
              workspacePath={workspacePath}
              conflict={editingConflict}
              sequenceKind={sequence.kind}
              onResolved={() => handleEditorResolved()}
              onError={handleEditorError}
            />
          </div>
        </div>
      </div>
    )
  }

  const seqGuide = conflictMap[actingKind]
  const showGuide = conflicts.length === 0 && actingKind !== 'none'

  // 文件列表形态
  return (
    <div className="fixed inset-0 bg-black/50 z-modal flex items-center justify-center p-6" data-testid="conflict-merger-dialog">
      <div className="bg-background-elevated rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-lg border border-border">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <AlertTriangle size={16} className="text-warning" />
            {t('conflict.dialogTitle')}
            {sequence.currentStep != null && sequence.totalSteps != null && (
              <span className="text-xs text-text-tertiary font-normal ml-2">
                {t('conflict.stepProgress', { current: sequence.currentStep, total: sequence.totalSteps })}
              </span>
            )}
          </h2>
          <button
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
            onClick={() => { closeMerger(); onClose() }}
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-2 border-b border-border bg-background-hover/30 flex items-center justify-between">
          <div className="text-xs text-text-secondary">
            {t('conflict.summary', { total: conflicts.length, text: textCount, simple: simpleCount })}
          </div>
          <button
            className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40"
            onClick={resolveAllSimple}
            disabled={busy || conflicts.length === 0}
            data-testid="resolve-all-simple"
          >
            {busy ? <Loader2 size={12} className="animate-spin inline mr-1" /> : <CheckCheck size={12} className="inline mr-1" />}
            {t('conflict.resolveAllSimple')}
          </button>
        </div>

        <div className="flex-1 overflow-auto p-2 space-y-1.5">
          {conflicts.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-text-secondary">
              {t('conflict.noConflicts')}
            </div>
          ) : (
            conflicts.map((entry) => (
              <div
                key={entry.path}
                className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-background-surface"
                data-testid="conflict-row"
              >
                <span
                  className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                    entry.kind === 'text'
                      ? 'bg-danger/10 text-danger'
                      : 'bg-warning/10 text-warning'
                  }`}
                >
                  {t(`conflict.kind.${entry.kind}`)}
                </span>
                <span className="text-sm text-text-primary truncate flex-1" title={entry.path}>
                  {entry.path}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  {entry.kind === 'text' ? (
                    <button
                      className="text-xs px-2 py-1 rounded border border-border text-text-secondary hover:bg-background-hover transition-colors"
                      onClick={() => setEditingFile(entry.path)}
                      data-testid={`resolve-manually-${entry.path}`}
                    >
                      {t('conflict.resolveManually')}
                    </button>
                  ) : (
                    <>
                      <button
                        className="text-xs px-2 py-1 rounded border border-primary/30 text-primary hover:bg-primary/10 transition-colors disabled:opacity-40"
                        disabled={busy || solvingPath === entry.path}
                        onClick={() => resolveSimple(entry, 'ours')}
                        data-testid={`resolve-ours-${entry.path}`}
                      >
                        {solvingPath === entry.path ? <Loader2 size={12} className="animate-spin inline mr-1" /> : null}
                        {simpleButtonLabel(entry, 'ours')}
                      </button>
                      <button
                        className="text-xs px-2 py-1 rounded border border-warning/30 text-warning hover:bg-warning/10 transition-colors disabled:opacity-40"
                        disabled={busy || solvingPath === entry.path}
                        onClick={() => resolveSimple(entry, 'theirs')}
                        data-testid={`resolve-theirs-${entry.path}`}
                      >
                        {simpleButtonLabel(entry, 'theirs')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* 收尾引导：冲突归零后按序列类型给出 Continue/Abort（merge → 提示去提交） */}
        {showGuide && (
          <div
            className="px-4 py-3 border-t border-border bg-success/5 flex items-center justify-between gap-2"
            data-testid="merger-guide"
          >
            <span className="text-xs text-text-secondary flex items-center gap-1.5">
              <Check size={14} className="text-success" />
              {actingKind === 'merge'
                ? t('conflict.guideMerge')
                : t('conflict.guideSequence')}
            </span>
            {seqGuide && (
              <div className="flex gap-1.5">
                <button
                  className="text-xs px-3 py-1.5 rounded border border-border text-text-secondary hover:bg-background-hover transition-colors disabled:opacity-40"
                  disabled={busy}
                  onClick={doSequenceAbort}
                  data-testid="sequence-abort"
                >
                  {t('conflict.sequenceAbort')}
                </button>
                <button
                  className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center gap-1"
                  disabled={busy}
                  onClick={doSequenceContinue}
                  data-testid="sequence-continue"
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  {t('conflict.sequenceContinue')}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end px-4 py-3 border-t border-border">
          <button
            className="text-xs px-3 py-1.5 rounded border border-border text-text-secondary hover:bg-background-hover transition-colors"
            onClick={() => { closeMerger(); onClose() }}
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
