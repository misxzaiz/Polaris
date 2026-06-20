/**
 * 文件变更列表组件
 *
 * 显示暂存和未暂存的文件变更，支持右键菜单
 */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { File, Check, X, Plus, Minus, GitCommit, RotateCcw, Trash2 } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useFileExplorerStore } from '@/stores'
import { useToastStore } from '@/stores/toastStore'
import { ContextMenu, type ContextMenuItem } from '@/components/FileExplorer/ContextMenu'
import { ConfirmDialog } from '@/components/Common/ConfirmDialog'
import type { GitFileChange } from '@/types'

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
  const { delete_file } = useFileExplorerStore()
  const toast = useToastStore()

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<{
    show: boolean
    title: string
    message: string
    type?: 'danger' | 'warning'
    onConfirm: () => void
  } | null>(null)

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const handleDiscard = useCallback((filePath: string) => {
    setConfirmDialog({
      show: true,
      title: t('confirmDiscardTitle'),
      message: t('confirmDiscardSingle', { file: filePath }),
      type: 'danger',
      onConfirm: async () => {
        setConfirmDialog(null)
        try {
          await discardChanges(workspacePath, filePath)
          toast.success(t('discardSuccess'))
        } catch {
          toast.error(t('errors.discardFailed'))
        }
      },
    })
  }, [workspacePath, discardChanges, toast, t])

  const handleDelete = useCallback((filePath: string) => {
    setConfirmDialog({
      show: true,
      title: t('confirmDeleteTitle'),
      message: t('confirmDeleteSingle', { file: filePath }),
      type: 'danger',
      onConfirm: async () => {
        setConfirmDialog(null)
        try {
          await delete_file(filePath)
          await refreshStatus(workspacePath)
          toast.success(t('deleteSuccess'))
        } catch {
          toast.error(t('errors.deleteFailed'))
        }
      },
    })
  }, [workspacePath, delete_file, refreshStatus, toast, t])

  const showContextMenu = useCallback((e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, items })
  }, [])

  const getStagedMenuItems = useCallback((filePath: string): ContextMenuItem[] => [
    { id: 'unstage', label: t('unstage'), icon: <X size={14} />, action: () => unstageFile(workspacePath, filePath) },
    { id: 'discard', label: t('discard'), icon: <RotateCcw size={14} />, action: () => handleDiscard(filePath) },
    { id: 'sep', label: '-', icon: undefined, action: () => {} },
    { id: 'delete', label: t('deleteFile'), icon: <Trash2 size={14} />, action: () => handleDelete(filePath) },
  ], [workspacePath, unstageFile, handleDiscard, handleDelete, t])

  const getUnstagedMenuItems = useCallback((filePath: string): ContextMenuItem[] => [
    { id: 'stage', label: t('stage'), icon: <Check size={14} />, action: () => stageFile(workspacePath, filePath) },
    { id: 'discard', label: t('discard'), icon: <RotateCcw size={14} />, action: () => handleDiscard(filePath) },
    { id: 'sep', label: '-', icon: undefined, action: () => {} },
    { id: 'delete', label: t('deleteFile'), icon: <Trash2 size={14} />, action: () => handleDelete(filePath) },
  ], [workspacePath, stageFile, handleDiscard, handleDelete, t])

  const getUntrackedMenuItems = useCallback((filePath: string): ContextMenuItem[] => [
    { id: 'stage', label: t('stage'), icon: <Check size={14} />, action: () => stageFile(workspacePath, filePath) },
    { id: 'sep', label: '-', icon: undefined, action: () => {} },
    { id: 'delete', label: t('deleteFile'), icon: <Trash2 size={14} />, action: () => handleDelete(filePath) },
  ], [workspacePath, stageFile, handleDelete, t])

  const getChangeIcon = (status: GitFileChange['status']) => {
    switch (status) {
      case 'added':
      case 'untracked':
        return <Plus size={12} className="text-success" />
      case 'deleted':
        return <Minus size={12} className="text-danger" />
      case 'modified':
        return <File size={12} className="text-warning" />
      case 'renamed':
        return <File size={12} className="text-info" />
      default:
        return <File size={12} className="text-text-tertiary" />
    }
  }

  const totalChanges = staged.length + unstaged.length + untracked.length
  const isAllSelected = totalChanges > 0 && selectedFiles.size === totalChanges
  const isSomeSelected = selectedFiles.size > 0

  if (totalChanges === 0) {
    return (
      <div className="flex-1 flex items-center justify-center py-12 text-text-tertiary text-sm">
        {t('status.noChanges')}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <div className="px-4 py-2 border-b border-border-subtle flex items-center gap-2">
        <input
          type="checkbox"
          checked={isAllSelected}
          ref={(input) => {
            if (input) {
              input.indeterminate = isSomeSelected && !isAllSelected
            }
          }}
          onChange={onSelectAll}
          disabled={isSelectionDisabled}
          className="w-4 h-4 rounded border-border"
        />
        <span className="text-xs text-text-secondary">
          {selectedFiles.size > 0 ? t('selectedFiles', { count: selectedFiles.size }) : t('selectAll')}
        </span>
      </div>

      {staged.length > 0 && (
        <div className="border-b border-border-subtle">
          <div className="px-4 py-2 text-xs font-medium text-text-secondary bg-background-surface">
            {t('status.staged')} ({staged.length})
          </div>
          <div className="py-1">
            {staged.map((file) => (
              <div
                key={file.path}
                className="flex items-center gap-2 px-4 py-1.5 hover:bg-background-hover group cursor-pointer"
                onClick={() => onFileClick?.(file, 'staged')}
                onContextMenu={(e) => showContextMenu(e, getStagedMenuItems(file.path))}
              >
                <input
                  type="checkbox"
                  checked={selectedFiles.has(file.path)}
                  onChange={(e) => {
                    e.stopPropagation()
                    onToggleFileSelection?.(file.path)
                  }}
                  disabled={isSelectionDisabled}
                  className="w-4 h-4 rounded border-border"
                  onClick={(e) => e.stopPropagation()}
                />
                {getChangeIcon(file.status)}
                <span className="flex-1 text-sm text-text-primary truncate">
                  {file.path}
                </span>
                {file.additions !== undefined && file.deletions !== undefined && (
                  <span className="text-xs text-text-tertiary">
                    <span className="text-success">+{file.additions}</span>
                    <span className="text-danger ml-1">-{file.deletions}</span>
                  </span>
                )}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                  {onBlame && file.status !== 'untracked' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onBlame(file.path)
                      }}
                      className="p-1 text-text-tertiary hover:text-primary hover:bg-background-surface rounded transition-all"
                      title={t('blame.button')}
                    >
                      <GitCommit size={12} />
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      unstageFile(workspacePath, file.path)
                    }}
                    className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-surface rounded transition-all"
                    title={t('unstage')}
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {unstaged.length > 0 && (
        <div className="border-b border-border-subtle">
          <div className="px-4 py-2 text-xs font-medium text-text-secondary bg-background-surface">
            {t('status.unstaged')} ({unstaged.length})
          </div>
          <div className="py-1">
            {unstaged.map((file) => (
              <div
                key={file.path}
                className="flex items-center gap-2 px-4 py-1.5 hover:bg-background-hover group cursor-pointer"
                onClick={() => onFileClick?.(file, 'unstaged')}
                onContextMenu={(e) => showContextMenu(e, getUnstagedMenuItems(file.path))}
              >
                <input
                  type="checkbox"
                  checked={selectedFiles.has(file.path)}
                  onChange={(e) => {
                    e.stopPropagation()
                    onToggleFileSelection?.(file.path)
                  }}
                  disabled={isSelectionDisabled}
                  className="w-4 h-4 rounded border-border"
                  onClick={(e) => e.stopPropagation()}
                />
                {getChangeIcon(file.status)}
                <span className="flex-1 text-sm text-text-primary truncate">
                  {file.path}
                </span>
                {file.additions !== undefined && file.deletions !== undefined && (
                  <span className="text-xs text-text-tertiary">
                    <span className="text-success">+{file.additions}</span>
                    <span className="text-danger ml-1">-{file.deletions}</span>
                  </span>
                )}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                  {onBlame && file.status !== 'untracked' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onBlame(file.path)
                      }}
                      className="p-1 text-text-tertiary hover:text-primary hover:bg-background-surface rounded transition-all"
                      title={t('blame.button')}
                    >
                      <GitCommit size={12} />
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      stageFile(workspacePath, file.path)
                    }}
                    className="p-1 text-text-tertiary hover:text-success hover:bg-background-surface rounded transition-all"
                    title={t('stage')}
                  >
                    <Check size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {untracked.length > 0 && (
        <div className="border-b border-border-subtle">
          <div className="px-4 py-2 text-xs font-medium text-text-secondary bg-background-surface">
            {t('status.untracked')} ({untracked.length})
          </div>
          <div className="py-1">
            {untracked.map((path) => (
              <div
                key={path}
                className="flex items-center gap-2 px-4 py-1.5 hover:bg-background-hover group cursor-pointer"
                onClick={() => onUntrackedFileClick?.(path)}
                onContextMenu={(e) => showContextMenu(e, getUntrackedMenuItems(path))}
              >
                <input
                  type="checkbox"
                  checked={selectedFiles.has(path)}
                  onChange={(e) => {
                    e.stopPropagation()
                    onToggleFileSelection?.(path)
                  }}
                  disabled={isSelectionDisabled}
                  className="w-4 h-4 rounded border-border"
                  onClick={(e) => e.stopPropagation()}
                />
                <Plus size={12} className="text-text-tertiary" />
                <span className="flex-1 text-sm text-text-primary truncate">
                  {path}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    stageFile(workspacePath, path)
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1 text-text-tertiary hover:text-success hover:bg-background-surface rounded transition-all"
                  title={t('stage')}
                >
                  <Check size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
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
