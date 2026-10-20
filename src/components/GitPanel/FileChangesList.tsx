/**
 * 文件变更列表组件
 *
 * 显示暂存和未暂存的文件变更，支持右键菜单
 */

import { useMemo, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'
import { Check, X, GitCommit, RotateCcw, Trash2, MoreHorizontal, Eye, ChevronRight, AlertTriangle } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useToastStore } from '@/stores/toastStore'
import { deleteFile } from '@/services/tauri/fileService'
import { resolveWorkspacePath } from '@/utils/path'
import { ContextMenu, type ContextMenuItem } from '@/components/FileExplorer/ContextMenu'
import { ConfirmDialog } from '@/components/Common/ConfirmDialog'
import type { GitFileChange, GitFileStatus } from '@/types'

type ChangeArea = 'staged' | 'unstaged' | 'untracked'

interface FileChangesListProps {
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: string[]
  workspacePath: string
  onFileClick?: (file: GitFileChange, type: 'staged' | 'unstaged') => void
  onUntrackedFileClick?: (path: string) => void
  onBlame?: (filePath: string) => void
  selectedFiles?: Set<string>
  onToggleFileSelection?: (path: string) => void
  onSelectAll?: () => void
  isSelectionDisabled?: boolean
}

interface ConfirmState {
  show: boolean
  title: string
  message: string
  type?: 'danger' | 'warning'
  onConfirm: () => void
}

/** 扁平化列表行：组头（折叠头）或数据行 */
interface FlatRow {
  type: 'header' | 'item'
  area: ChangeArea
  /** 数据行在对应排序数组中的索引（组头行无意义） */
  index: number
  /** 数据行的文件路径（组头行为空串） */
  path: string
}

function splitPath(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index < 0) return { dir: '', name: filePath }
  return {
    dir: normalized.slice(0, index + 1),
    name: normalized.slice(index + 1),
  }
}

function getStatusCode(status: GitFileStatus, area: ChangeArea) {
  if (area === 'untracked' || status === 'added' || status === 'untracked') return 'A'
  if (status === 'deleted') return 'D'
  if (status === 'renamed') return 'R'
  if (status === 'unmerged') return 'U'
  return 'M'
}

function sortByPath(a: string | { path: string }, b: string | { path: string }) {
  const pa = (typeof a === 'string' ? a : a.path).toLowerCase()
  const pb = (typeof b === 'string' ? b : b.path).toLowerCase()
  // 目录优先：按父目录分组，再按文件名排序
  const dirA = pa.replace(/\/[^/]*$/, '/')
  const dirB = pb.replace(/\/[^/]*$/, '/')
  if (dirA !== dirB) return dirA.localeCompare(dirB)
  return pa.localeCompare(pb)
}

function getStatusClass(status: GitFileStatus, area: ChangeArea) {
  if (area === 'untracked' || status === 'added' || status === 'untracked') return 'text-success border-success/20 bg-success/10'
  if (status === 'deleted') return 'text-danger border-danger/20 bg-danger/10'
  if (status === 'renamed') return 'text-info border-info/20 bg-info/10'
  if (status === 'unmerged') return 'text-danger border-danger/20 bg-danger/10'
  return 'text-warning border-warning/20 bg-warning/10'
}

export function FileChangesList({
  staged,
  unstaged,
  untracked,
  workspacePath,
  onFileClick,
  onUntrackedFileClick,
  onBlame,
  selectedFiles = new Set(),
  onToggleFileSelection,
  onSelectAll,
  isSelectionDisabled = false
}: FileChangesListProps) {
  const { t } = useTranslation('git')
  const { stageFile, unstageFile, discardChanges, refreshStatus, openMerger } = useGitStore()
  const toast = useToastStore()

  const [operatingPath, setOperatingPath] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<ConfirmState | null>(null)
  // 折叠状态：key 为 'staged' | 'unstaged' | 'untracked'
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const visiblePaths = useMemo(() => Array.from(new Set([
    ...staged.map((file) => file.path),
    ...unstaged.map((file) => file.path),
    ...untracked,
  ])), [staged, unstaged, untracked])

  // 排序仅在对应数据变化时执行，避免每次渲染全量排序
  const sortedStaged = useMemo(() => [...staged].sort(sortByPath), [staged])
  const sortedUnstaged = useMemo(() => [...unstaged].sort(sortByPath), [unstaged])
  const sortedUntracked = useMemo(() => [...untracked].sort(sortByPath), [untracked])

  // 扁平化行模型：三组 [组头] + [数据行…] 交替。折叠的分组只保留组头，数据行不进入列表
  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = []
    const areas: ChangeArea[] = ['staged', 'unstaged', 'untracked']
    for (const area of areas) {
      const data = area === 'staged' ? sortedStaged : area === 'unstaged' ? sortedUnstaged : sortedUntracked
      if (data.length === 0) continue
      // 组头行
      rows.push({ type: 'header', area, index: 0, path: '' })
      if (collapsed[area]) continue
      // 数据行（保留原语义顺序）
      rows.push(...data.map((entry, i) => ({
        type: 'item' as const,
        area,
        index: i,
        path: typeof entry === 'string' ? entry : entry.path,
      })))
    }
    return rows
  }, [collapsed, sortedStaged, sortedUnstaged, sortedUntracked])

  // 是否走虚拟化：仅当总数据行数较大时启用（小列表保持普通 DOM 渲染，零回归）
  const totalChanges = staged.length + unstaged.length + untracked.length
  const VIRTUALIZE_THRESHOLD = 200
  const shouldVirtualize = totalChanges > VIRTUALIZE_THRESHOLD

  const runAction = useCallback(async (
    filePath: string,
    action: () => Promise<void>,
    messages: { success?: string; error: string }
  ) => {
    setOperatingPath(filePath)
    try {
      await action()
      if (messages.success) toast.success(messages.success)
    } catch (err) {
      toast.error(messages.error, err instanceof Error ? err.message : String(err))
    } finally {
      setOperatingPath(null)
    }
  }, [toast])

  const handleStage = useCallback((filePath: string) => {
    void runAction(filePath, () => stageFile(workspacePath, filePath), {
      success: t('stageSuccess'),
      error: t('errors.stageFailed'),
    })
  }, [runAction, stageFile, workspacePath, t])

  const handleUnstage = useCallback((filePath: string) => {
    void runAction(filePath, () => unstageFile(workspacePath, filePath), {
      success: t('unstageSuccess'),
      error: t('errors.unstageFailed'),
    })
  }, [runAction, unstageFile, workspacePath, t])

  const handleDiscard = useCallback((filePath: string, isRestore = false) => {
    setConfirmDialog({
      show: true,
      title: isRestore ? t('confirmRestoreTitle') : t('confirmDiscardTitle'),
      message: isRestore
        ? t('confirmRestoreSingle', { file: filePath })
        : t('confirmDiscardSingle', { file: filePath }),
      type: 'danger',
      onConfirm: () => {
        setConfirmDialog(null)
        void runAction(filePath, () => discardChanges(workspacePath, filePath), {
          success: isRestore ? t('restoreSuccess') : t('discardSuccess'),
          error: t('errors.discardFailed'),
        })
      },
    })
  }, [workspacePath, discardChanges, runAction, t])

  const handleDelete = useCallback((filePath: string, isUntracked: boolean) => {
    setConfirmDialog({
      show: true,
      title: t('confirmDeleteTitle'),
      message: isUntracked
        ? t('confirmDeleteUntrackedSingle', { file: filePath })
        : t('confirmDeleteSingle', { file: filePath }),
      type: 'danger',
      onConfirm: () => {
        setConfirmDialog(null)
        void runAction(filePath, async () => {
          await deleteFile(resolveWorkspacePath(workspacePath, filePath))
          await refreshStatus(workspacePath)
        }, {
          success: isUntracked ? t('deleteUntrackedSuccess') : t('deleteSuccess'),
          error: t('errors.deleteFailed'),
        })
      },
    })
  }, [workspacePath, refreshStatus, runAction, t])

  const openDiff = useCallback((filePath: string, area: ChangeArea, file?: GitFileChange) => {
    if (area === 'untracked') {
      onUntrackedFileClick?.(filePath)
    } else if (file) {
      onFileClick?.(file, area)
    }
  }, [onFileClick, onUntrackedFileClick])

  const buildMenuItems = useCallback((filePath: string, area: ChangeArea, status: GitFileStatus, file?: GitFileChange): ContextMenuItem[] => {
    const items: ContextMenuItem[] = []

    // 冲突文件（unmerged）：菜单首位给「打开冲突合并器」入口（P3，优先于看 diff——
    // 冲突态的 diff 含 marker，合并器才是正解路径）
    if (status === 'unmerged') {
      items.push({
        id: 'merger',
        label: t('mergerEntry'),
        icon: <AlertTriangle size={14} />,
        action: () => openMerger(workspacePath, filePath),
      })
    }

    items.push(
      { id: 'diff', label: t('openDiff'), icon: <Eye size={14} />, action: () => openDiff(filePath, area, file) },
    )

    if (onBlame && area !== 'untracked' && status !== 'untracked' && status !== 'deleted') {
      items.push({ id: 'blame', label: t('blame.button'), icon: <GitCommit size={14} />, action: () => onBlame(filePath) })
    }

    items.push({ id: 'sep-main', label: '-', icon: undefined, action: () => {} })

    if (area === 'staged') {
      items.push({ id: 'unstage', label: t('unstage'), icon: <X size={14} />, action: () => handleUnstage(filePath) })
      return items
    }

    items.push({
      id: 'stage',
      label: status === 'deleted' ? t('stageDeleted') : t('stage'),
      icon: <Check size={14} />,
      action: () => handleStage(filePath),
    })

    if (status === 'deleted') {
      items.push({ id: 'restore', label: t('restoreFile'), icon: <RotateCcw size={14} />, action: () => handleDiscard(filePath, true) })
      return items
    }

    if (area === 'unstaged') {
      items.push({ id: 'discard', label: t('discard'), icon: <RotateCcw size={14} />, action: () => handleDiscard(filePath) })
      items.push({ id: 'sep-delete', label: '-', icon: undefined, action: () => {} })
      items.push({ id: 'delete', label: t('deleteFile'), icon: <Trash2 size={14} />, action: () => handleDelete(filePath, false) })
      return items
    }

    items.push({ id: 'sep-delete', label: '-', icon: undefined, action: () => {} })
    items.push({ id: 'delete-untracked', label: t('deleteUntracked'), icon: <Trash2 size={14} />, action: () => handleDelete(filePath, true) })
    return items
  }, [handleDelete, handleDiscard, handleStage, handleUnstage, onBlame, openDiff, openMerger, workspacePath, t])

  const showContextMenu = useCallback((e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, items })
  }, [])

  const isAllSelected = visiblePaths.length > 0 && visiblePaths.every((path) => selectedFiles.has(path))
  const isSomeSelected = visiblePaths.some((path) => selectedFiles.has(path))

  const renderChangeRow = (params: {
    filePath: string
    area: ChangeArea
    status: GitFileStatus
    file?: GitFileChange
    additions?: number
    deletions?: number
  }) => {
    const { filePath, area, status, file, additions, deletions } = params
    const selected = selectedFiles.has(filePath)
    const isOperating = operatingPath === filePath
    const { dir, name } = splitPath(filePath)
    const statusCode = getStatusCode(status, area)

    return (
      <div
        key={`${area}:${filePath}`}
        className={`grid grid-cols-[16px_28px_minmax(0,1fr)_auto_auto] items-center gap-1 px-3 min-h-[26px] border-b border-border-subtle/60 hover:bg-background-hover group cursor-pointer ${selected ? 'bg-primary/10' : ''} ${isOperating ? 'opacity-60 pointer-events-none' : ''}`}
        onClick={() => openDiff(filePath, area, file)}
        onContextMenu={(e) => showContextMenu(e, buildMenuItems(filePath, area, status, file))}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => {
            e.stopPropagation()
            onToggleFileSelection?.(filePath)
          }}
          disabled={isSelectionDisabled || isOperating}
          className="w-3 h-3 rounded border-border"
          onClick={(e) => e.stopPropagation()}
          aria-label={filePath}
        />

        <div className="flex items-center min-w-0">
          <span className={`inline-flex items-center justify-center w-[16px] h-[16px] rounded border text-[9px] font-semibold ${getStatusClass(status, area)}`}>
            {statusCode}
          </span>
        </div>

        <div className="flex items-center min-w-0 gap-0.5" title={filePath}>
          {dir && <span className="text-text-tertiary/70 truncate min-w-0 text-[11px] font-normal leading-none">{dir}</span>}
          <span className="text-text-primary text-xs font-medium shrink-0 leading-none">{name}</span>
        </div>

        {(additions !== undefined || deletions !== undefined) && (
          <span className="text-[10px] text-text-tertiary tabular-nums whitespace-nowrap">
            <span className="text-success">+{additions ?? 0}</span>
            <span className="text-danger ml-1">-{deletions ?? 0}</span>
          </span>
        )}

        <div className="flex items-center justify-end opacity-80 group-hover:opacity-100">
          <button
            onClick={(e) => showContextMenu(e, buildMenuItems(filePath, area, status, file))}
            className="p-0.5 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-all"
            title={t('moreActions')}
            type="button"
          >
            <MoreHorizontal size={12} />
          </button>
        </div>
      </div>
    )
  }

  const toggleCollapse = useCallback((area: ChangeArea) => {
    setCollapsed((prev) => ({ ...prev, [area]: !prev[area] }))
  }, [])

  // 组头（折叠头）
  const renderGroupHeader = (area: ChangeArea) => {
    const isCollapsed = !!collapsed[area]
    const count = area === 'staged' ? sortedStaged.length : area === 'unstaged' ? sortedUnstaged.length : sortedUntracked.length
    return (
      <div
        className="sticky top-0 z-10 h-7 px-3 flex items-center justify-between text-xs font-medium text-text-secondary bg-background-surface cursor-pointer select-none hover:bg-background-hover"
        onClick={() => toggleCollapse(area)}
        title={isCollapsed ? t('expand') : t('collapse')}
      >
        <span className="flex items-center gap-1">
          <ChevronRight size={12} className={`transition-transform duration-150 ${isCollapsed ? '' : 'rotate-90'}`} />
          <span>{area === 'staged' ? t('status.staged') : area === 'unstaged' ? t('status.unstaged') : t('status.untracked')} ({count})</span>
        </span>
      </div>
    )
  }

  // 渲染扁平行（组头或数据行）
  const renderFlatRow = (row: FlatRow) => {
    if (row.type === 'header') {
      return (
        <div key={`header:${row.area}`} className="border-b border-border-subtle">
          {renderGroupHeader(row.area)}
        </div>
      )
    }
    const { area } = row
    if (area === 'staged') {
      const file = sortedStaged[row.index]
      return renderChangeRow({
        filePath: file.path,
        area,
        status: file.status,
        file,
        additions: file.additions,
        deletions: file.deletions,
      })
    }
    if (area === 'unstaged') {
      const file = sortedUnstaged[row.index]
      return renderChangeRow({
        filePath: file.path,
        area,
        status: file.status,
        file,
        additions: file.additions,
        deletions: file.deletions,
      })
    }
    const p = sortedUntracked[row.index]
    return renderChangeRow({
      filePath: p,
      area,
      status: 'untracked',
    })
  }

  if (totalChanges === 0) {
    return (
      <div className="flex-1 flex items-center justify-center py-10 text-text-tertiary text-sm">
        {t('status.noChanges')}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <div className="sticky top-0 z-20 h-8 px-3 border-b border-border-subtle bg-background-elevated flex items-center gap-2">
        <input
          type="checkbox"
          checked={isAllSelected}
          ref={(input) => {
            if (input) input.indeterminate = isSomeSelected && !isAllSelected
          }}
          onChange={onSelectAll}
          disabled={isSelectionDisabled}
          className="w-3.5 h-3.5 rounded border-border"
        />
        <span className="text-xs text-text-secondary truncate">
          {selectedFiles.size > 0 ? t('selectedFiles', { count: selectedFiles.size }) : t('selectAll')}
        </span>
      </div>

      {/* 三组文件变更列表：组头(可折叠) + 数据行。数据行多时走 Virtuoso 虚拟化，小列表保持普通 DOM 渲染 */}
      {shouldVirtualize ? (
        <Virtuoso
          data={flatRows}
          computeItemKey={(index) => {
            const row = flatRows[index]
            return row.type === 'header'
              ? `header:${row.area}`
              : `item:${row.area}:${row.path}`
          }}
          itemContent={(_index, row) => renderFlatRow(row)}
          style={{ flex: 1, minHeight: 0 }}
        />
      ) : (
        <div className="min-h-0">{flatRows.map((row) => renderFlatRow(row))}</div>
      )}

      {contextMenu && (
        <ContextMenu
          visible
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={closeContextMenu}
        />
      )}

      {confirmDialog?.show && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          type={confirmDialog.type}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  )
}
