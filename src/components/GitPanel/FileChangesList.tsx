/**
 * 文件变更列表组件
 *
 * 显示暂存和未暂存的文件变更，支持右键菜单
 */

import { useMemo, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X, GitCommit, RotateCcw, Trash2, MoreHorizontal, Eye } from 'lucide-react'
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
  const { stageFile, unstageFile, discardChanges, refreshStatus } = useGitStore()
  const toast = useToastStore()

  const [operatingPath, setOperatingPath] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<ConfirmState | null>(null)

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const visiblePaths = useMemo(() => Array.from(new Set([
    ...staged.map((file) => file.path),
    ...unstaged.map((file) => file.path),
    ...untracked,
  ])), [staged, unstaged, untracked])

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
    const items: ContextMenuItem[] = [
      { id: 'diff', label: t('openDiff'), icon: <Eye size={14} />, action: () => openDiff(filePath, area, file) },
    ]

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
  }, [handleDelete, handleDiscard, handleStage, handleUnstage, onBlame, openDiff, t])

  const showContextMenu = useCallback((e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, items })
  }, [])

  const totalChanges = staged.length + unstaged.length + untracked.length
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
    const canBlame = onBlame && area !== 'untracked' && status !== 'untracked' && status !== 'deleted'
    const primaryAction = area === 'staged'
      ? { title: t('unstage'), icon: <X size={12} />, onClick: () => handleUnstage(filePath), className: 'hover:text-text-primary' }
      : { title: status === 'deleted' ? t('stageDeleted') : t('stage'), icon: <Check size={12} />, onClick: () => handleStage(filePath), className: 'hover:text-success' }

    return (
      <div
        key={`${area}:${filePath}`}
        className={`grid grid-cols-[18px_34px_minmax(0,1fr)_auto_auto] items-center gap-1.5 px-3 min-h-[30px] border-b border-border-subtle/60 hover:bg-background-hover group cursor-pointer ${selected ? 'bg-primary/10' : ''} ${isOperating ? 'opacity-60 pointer-events-none' : ''}`}
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
          className="w-3.5 h-3.5 rounded border-border"
          onClick={(e) => e.stopPropagation()}
          aria-label={filePath}
        />

        <div className="flex items-center min-w-0">
          <span className={`inline-flex items-center justify-center w-[18px] h-[18px] rounded border text-[10px] font-bold ${getStatusClass(status, area)}`}>
            {statusCode}
          </span>
        </div>

        <div className="flex items-center min-w-0 gap-1.5">
          <span className="min-w-0 truncate text-xs text-text-primary" title={filePath}>
            {dir && <span className="text-text-tertiary">{dir}</span>}{name}
          </span>
          <span className={`shrink-0 px-1.5 h-[17px] rounded-full border text-[10px] leading-[15px] ${area === 'staged' ? 'text-success bg-success/10 border-success/20' : area === 'untracked' ? 'text-info bg-info/10 border-info/20' : status === 'deleted' ? 'text-danger bg-danger/10 border-danger/20' : 'text-text-tertiary bg-background-surface border-border'}`}>
            {area === 'staged' ? t('status.staged') : area === 'untracked' ? t('status.untracked') : status === 'deleted' ? t('changes.deleted') : t('status.unstaged')}
          </span>
        </div>

        {(additions !== undefined || deletions !== undefined) && (
          <span className="text-[11px] text-text-tertiary tabular-nums whitespace-nowrap">
            <span className="text-success">+{additions ?? 0}</span>
            <span className="text-danger ml-1">-{deletions ?? 0}</span>
          </span>
        )}

        <div className="flex items-center justify-end gap-0.5 opacity-80 group-hover:opacity-100">
          {canBlame && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onBlame(filePath)
              }}
              className="p-1 text-text-tertiary hover:text-primary hover:bg-background-surface rounded transition-all"
              title={t('blame.button')}
              type="button"
            >
              <GitCommit size={12} />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              primaryAction.onClick()
            }}
            className={`p-1 text-text-tertiary hover:bg-background-surface rounded transition-all ${primaryAction.className}`}
            title={primaryAction.title}
            type="button"
          >
            {primaryAction.icon}
          </button>
          <button
            onClick={(e) => showContextMenu(e, buildMenuItems(filePath, area, status, file))}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-surface rounded transition-all"
            title={t('moreActions')}
            type="button"
          >
            <MoreHorizontal size={12} />
          </button>
        </div>
      </div>
    )
  }

  const renderGroup = (title: string, count: number, children: React.ReactNode) => {
    if (count === 0) return null
    return (
      <div className="border-b border-border-subtle">
        <div className="sticky top-0 z-10 h-7 px-3 flex items-center justify-between text-xs font-medium text-text-secondary bg-background-surface border-b border-border-subtle">
          <span>{title} ({count})</span>
        </div>
        <div>{children}</div>
      </div>
    )
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

      {renderGroup(t('status.staged'), staged.length, staged.map((file) => renderChangeRow({
        filePath: file.path,
        area: 'staged',
        status: file.status,
        file,
        additions: file.additions,
        deletions: file.deletions,
      })))}

      {renderGroup(t('status.unstaged'), unstaged.length, unstaged.map((file) => renderChangeRow({
        filePath: file.path,
        area: 'unstaged',
        status: file.status,
        file,
        additions: file.additions,
        deletions: file.deletions,
      })))}

      {renderGroup(t('status.untracked'), untracked.length, untracked.map((path) => renderChangeRow({
        filePath: path,
        area: 'untracked',
        status: 'untracked',
      })))}

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
