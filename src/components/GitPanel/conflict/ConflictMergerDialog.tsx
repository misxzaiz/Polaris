/**
 * 冲突合并对话框（P3 FR-P3-1：文件级 ealt）
 *
 * 两形态：
 * 1. 文件列表形态：列出全部冲突条目，每文件 Accept Yours / Accept Theirs / Resolve Manually
 *    + Resolve All Simple Conflicts 一键（binary/deleted_by_* 自动取 ours + 剩余 Text 进编辑器）
 * 2. 编辑器形态：选中 Text 文件 → 内嵌 ThreeWayMergeEditor（per-hunk 决策 → 直落 staging）
 *
 * 数据源：`GitSequenceState`（store.getConflictState）。
 * 简单解决走 `git_resolve_conflict_file`（写内容 + add）。
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCheck, FileCode, Loader2, X } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useToastStore } from '@/stores/toastStore'
import { invoke } from '@/services/transport'
import { ThreeWayMergeEditor } from './ThreeWayMergeEditor'
import type { GitSequenceState, GitConflictEntry, GitConflictKind } from '@/types/git'

interface ConflictMergerDialogProps {
  workspacePath: string
  sequence: GitSequenceState
  onClose: () => void
  /** 解决任何文件后刷新（父级重新拉 getConflictState + refreshStatus） */
  onRefresh: () => void
}

/** 简单解决的 kind：binary（无 marker）与 deleted_by_*（整文件取舍相）
 * 不需要 per-hunk 编辑器，走文件级整取舍 */
function isSimpleKind(kind: GitConflictKind): boolean {
  return kind !== 'text'
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

  const conflicts = useMemo(() => sequence.conflicts ?? [], [sequence.conflicts])
  const [editingFile, setEditingFile] = useState<string | null>(null) // 当前进编辑器的文件
  const [solvingPath, setSolvingPath] = useState<string | null>(null) // 正在表达式解决的文件
  const [busy, setBusy] = useState(false)

  const editingConflict = editingFile
    ? conflicts.find((c) => c.path === editingFile) ?? null
    : null

  const textCount = conflicts.filter((c) => c.kind === 'text').length
  const simpleCount = conflicts.length - textCount

  async function resolveSimple(entry: GitConflictEntry, side: 'ours' | 'theirs') {
    if (solvingPath) return // 防并发
    setSolvingPath(entry.path)
    setBusy(true)
    try {
      // 写对应侧内容并 stage（binary/deleted_by_* 无 marker，整文件取侧）
      await invoke('git_resolve_conflict_file', {
        workspacePath,
        filePath: entry.path,
        content: side === 'ours' ? (entry.ours ?? '') : (entry.theirs ?? ''),
      })
      toast.success(t('conflict.fileResolved', { file: entry.path }))
      const s = await getConflictState(workspacePath)
      if (!s || !s.conflicts.some((c) => c.path === entry.path)) {
        onRefresh()
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSolvingPath(null)
      setBusy(false)
    }
  }

  /** Resolve All Simple Conflicts：所有非 Text 自动取 ours，文本冲突依次进编辑器 */
  async function resolveAllSimple() {
    if (busy) return
    setBusy(true)
    try {
      for (const c of conflicts.filter((x) => isSimpleKind(x.kind))) {
        await invoke('git_resolve_conflict_file', {
          workspacePath,
          filePath: c.path,
          content: c.ours ?? '',
        })
      }
      await getConflictState(workspacePath)
      onRefresh()
      // 剩余 Text 进编辑器
      const nextText = conflicts.find((x) => x.kind === 'text')
      if (nextText) setEditingFile(nextText.path)
      toast.success(t('conflict.resolveAllDone'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleEditorResolved = async () => {
    setEditingFile(null)
    const s = await getConflictState(workspacePath)
    if (!s || s.conflicts.length === 0) {
      toast.success(t('conflict.allFilesDone'))
      onRefresh()
      closeMerger()
    }
  }

  const handleEditorError = (msg: string) => {
    if (msg === 'cancelled') {
      setEditingFile(null)
      return
    }
    toast.error(msg)
  }

  // 编辑器形态
  if (editingConflict) {
    return (
      <div className="fixed inset-0 bg-black/50 z-modal flex items-center justify-center p-6">
        <div className="bg-background-elevated rounded-xl w-full max-w-4xl max-h-[80vh] flex flex-col shadow-lg border border-border">
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

  // 文件列表形态
  return (
    <div className="fixed inset-0 bg-black/50 z-modal flex items-center justify-center p-6">
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
                  <button
                    className="text-xs px-2 py-1 rounded border border-primary/30 text-primary hover:bg-primary/10 transition-colors disabled:opacity-40"
                    disabled={busy || solvingPath === entry.path}
                    onClick={() => resolveSimple(entry, 'ours')}
                  >
                    {t('conflict.acceptYours')}
                  </button>
                  <button
                    className="text-xs px-2 py-1 rounded border border-warning/30 text-warning hover:bg-warning/10 transition-colors disabled:opacity-40"
                    disabled={busy || solvingPath === entry.path}
                    onClick={() => resolveSimple(entry, 'theirs')}
                  >
                    {t('conflict.acceptTheirs')}
                  </button>
                  {entry.kind === 'text' && (
                    <button
                      className="text-xs px-2 py-1 rounded border border-border text-text-secondary hover:bg-background-hover transition-colors"
                      onClick={() => setEditingFile(entry.path)}
                      data-testid={`resolve-manually-${entry.path}`}
                    >
                      {t('conflict.resolveManually')}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

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