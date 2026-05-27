import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Archive,
  Loader2,
  X,
  GitBranch as GitBranchIcon,
  Check,
  GitMerge,
  GitCompare,
  AlertCircle,
  Square,
  Play,
} from 'lucide-react'
import type { GitMergeResult, GitRebaseResult } from '@/types/git'

// ─── Switch Confirm Dialog ───

interface SwitchConfirmDialogProps {
  changesCount: number
  isSwitching: boolean
  onStashAndSwitch: () => void
  onForceSwitch: () => void
  onCancel: () => void
}

export function SwitchConfirmDialog({
  changesCount,
  isSwitching,
  onStashAndSwitch,
  onForceSwitch,
  onCancel,
}: SwitchConfirmDialogProps) {
  const { t } = useTranslation('git')

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg relative">
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle size={20} className="text-warning shrink-0 mt-0.5" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary mb-1">
              {t('branch.uncommittedChanges')}
            </h2>
            <p className="text-sm text-text-secondary">
              {t('branch.uncommittedChangesDesc', { count: changesCount })}
            </p>
          </div>
        </div>

        <div className="space-y-2 mb-6">
          <button
            onClick={onStashAndSwitch}
            disabled={isSwitching}
            className="w-full px-4 py-3 text-left text-sm bg-background-surface hover:bg-background-hover border border-border rounded-lg transition-colors flex items-center gap-3 disabled:opacity-50"
          >
            <Archive size={16} className="text-primary" />
            <div>
              <div className="font-medium text-text-primary">
                {t('branch.stashAndSwitch')}
              </div>
              <div className="text-xs text-text-tertiary">
                {t('branch.stashAndSwitchDesc')}
              </div>
            </div>
          </button>

          <button
            onClick={onForceSwitch}
            disabled={isSwitching}
            className="w-full px-4 py-3 text-left text-sm bg-danger/10 hover:bg-danger/20 border border-danger/30 rounded-lg transition-colors flex items-center gap-3 disabled:opacity-50"
          >
            <AlertTriangle size={16} className="text-danger" />
            <div>
              <div className="font-medium text-danger">{t('branch.forceSwitch')}</div>
              <div className="text-xs text-danger/70">{t('branch.forceSwitchDesc')}</div>
            </div>
          </button>
        </div>

        <div className="flex justify-end">
          <button
            onClick={onCancel}
            disabled={isSwitching}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
          >
            {t('cancel', { ns: 'common' })}
          </button>
        </div>

        {isSwitching && (
          <div className="absolute inset-0 bg-background-elevated/80 flex items-center justify-center rounded-xl">
            <Loader2 size={24} className="animate-spin text-primary" />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Create Branch Dialog ───

interface CreateBranchDialogProps {
  currentBranch: string
  isCreating: boolean
  onConfirm: (name: string, checkout: boolean) => void
  onClose: () => void
}

export function CreateBranchDialog({
  currentBranch,
  isCreating,
  onConfirm,
  onClose,
}: CreateBranchDialogProps) {
  const { t } = useTranslation('git')
  const [name, setName] = useState('')
  const [checkout, setCheckout] = useState(true)

  const handleConfirm = () => onConfirm(name, checkout)
  const handleClose = () => {
    onClose()
    setName('')
    setCheckout(true)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">
            {t('branch.create')}
          </h2>
          <button
            onClick={handleClose}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1.5">
              {t('branch.nameLabel')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm() }}
              placeholder={t('branch.newBranchPlaceholder')}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
              autoFocus
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={checkout}
              onChange={(e) => setCheckout(e.target.checked)}
              className="w-4 h-4 rounded border-border text-primary focus:ring-primary/50"
            />
            <span className="text-sm text-text-secondary">
              {t('branch.checkoutAfterCreate')}
            </span>
          </label>

          <div className="text-xs text-text-tertiary">
            {t('branch.createFrom', { branch: currentBranch || 'HEAD' })}
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={handleClose}
            disabled={isCreating}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
          >
            {t('cancel', { ns: 'common' })}
          </button>
          <button
            onClick={handleConfirm}
            disabled={isCreating || !name.trim()}
            className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isCreating && <Loader2 size={14} className="animate-spin" />}
            {t('branch.create')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Delete Branch Dialog ───

interface DeleteBranchDialogProps {
  branchName: string
  isDeleting: boolean
  forceDelete: boolean
  onConfirm: () => void
  onClose: () => void
}

export function DeleteBranchDialog({
  branchName,
  isDeleting,
  forceDelete,
  onConfirm,
  onClose,
}: DeleteBranchDialogProps) {
  const { t } = useTranslation('git')

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg">
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle size={20} className="text-warning shrink-0 mt-0.5" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary mb-1">
              {t('branch.delete')}
            </h2>
            <p className="text-sm text-text-secondary">
              {t('branch.deleteConfirm', { branch: branchName })}
            </p>
          </div>
        </div>

        {forceDelete && (
          <div className="mb-4 px-3 py-2 bg-warning/10 border border-warning/30 rounded-lg">
            <p className="text-sm text-warning">
              {t('branch.notMergedWarning')}
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={isDeleting}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
          >
            {t('cancel', { ns: 'common' })}
          </button>
          <button
            onClick={onConfirm}
            disabled={isDeleting}
            className="px-4 py-2 text-sm bg-danger text-white rounded-lg hover:bg-danger/90 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isDeleting && <Loader2 size={14} className="animate-spin" />}
            {forceDelete ? t('branch.forceDelete') : t('branch.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Rename Branch Dialog ───

interface RenameBranchDialogProps {
  branchName: string
  isRenaming: boolean
  onConfirm: (newName: string) => void
  onClose: () => void
}

export function RenameBranchDialog({
  branchName,
  isRenaming,
  onConfirm,
  onClose,
}: RenameBranchDialogProps) {
  const { t } = useTranslation('git')
  const [newName, setNewName] = useState(branchName)

  const handleConfirm = () => onConfirm(newName)
  const handleClose = () => {
    onClose()
    setNewName('')
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">
            {t('branch.rename')}
          </h2>
          <button
            onClick={handleClose}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1.5">
              {t('branch.currentName')}
            </label>
            <div className="px-3 py-2 text-sm bg-background-surface border border-border rounded-lg text-text-tertiary">
              {branchName}
            </div>
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1.5">
              {t('branch.newNameLabel')}
            </label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm() }}
              placeholder={t('branch.newNamePlaceholder')}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
              autoFocus
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={handleClose}
            disabled={isRenaming}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
          >
            {t('cancel', { ns: 'common' })}
          </button>
          <button
            onClick={handleConfirm}
            disabled={isRenaming || !newName.trim() || newName === branchName}
            className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isRenaming && <Loader2 size={14} className="animate-spin" />}
            {t('branch.rename')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Merge Branch Dialog ───

interface MergeBranchDialogProps {
  sourceBranch: string
  currentBranch: string
  isMerging: boolean
  mergeResult: GitMergeResult | null
  onConfirm: (noFF: boolean) => void
  onClose: () => void
}

export function MergeBranchDialog({
  sourceBranch,
  currentBranch,
  isMerging,
  mergeResult,
  onConfirm,
  onClose,
}: MergeBranchDialogProps) {
  const { t } = useTranslation('git')
  const [noFF, setNoFF] = useState(false)

  const handleConfirm = () => onConfirm(noFF)
  const handleClose = () => {
    if (!isMerging) {
      onClose()
      setNoFF(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">
            {t('branch.merge')}
          </h2>
          <button
            onClick={handleClose}
            disabled={isMerging}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          <div className="px-4 py-3 bg-background-surface border border-border rounded-lg">
            <div className="text-sm text-text-secondary mb-1">{t('branch.mergeSource')}</div>
            <div className="flex items-center gap-2">
              <GitBranchIcon size={14} className="text-success" />
              <span className="text-sm font-medium text-text-primary">{sourceBranch}</span>
            </div>
          </div>

          <div className="flex items-center justify-center text-text-tertiary">
            <span className="text-2xl">↓</span>
          </div>

          <div className="px-4 py-3 bg-primary/5 border border-primary/20 rounded-lg">
            <div className="text-sm text-text-secondary mb-1">{t('branch.mergeTarget')}</div>
            <div className="flex items-center gap-2">
              <Check size={14} className="text-primary" />
              <span className="text-sm font-medium text-text-primary">{currentBranch}</span>
              <span className="text-xs px-1.5 py-0.5 bg-primary/20 text-primary rounded">
                {t('branch.current')}
              </span>
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={noFF}
              onChange={(e) => setNoFF(e.target.checked)}
              disabled={isMerging}
              className="w-4 h-4 rounded border-border text-primary focus:ring-primary/50"
            />
            <div>
              <span className="text-sm text-text-secondary">
                {t('branch.mergeNoFF')}
              </span>
              <span className="text-xs text-text-tertiary block">
                {t('branch.mergeNoFFDesc')}
              </span>
            </div>
          </label>

          {mergeResult?.hasConflicts && (
            <div className="px-3 py-2 bg-warning/10 border border-warning/30 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertCircle size={16} className="text-warning shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-warning">
                    {t('branch.mergeConflicts')}
                  </div>
                  <div className="text-xs text-warning/70 mt-1">
                    {t('branch.mergeConflictsDesc', { count: mergeResult.conflicts.length })}
                  </div>
                  <div className="mt-2 max-h-24 overflow-y-auto">
                    {mergeResult.conflicts.map((file, idx) => (
                      <div key={idx} className="text-xs text-text-tertiary font-mono">
                        {file}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={handleClose}
            disabled={isMerging}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
          >
            {t('cancel', { ns: 'common' })}
          </button>
          <button
            onClick={handleConfirm}
            disabled={isMerging}
            className="px-4 py-2 text-sm bg-success text-white rounded-lg hover:bg-success/90 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isMerging && <Loader2 size={14} className="animate-spin" />}
            <GitMerge size={14} />
            {t('branch.merge')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Rebase Branch Dialog ───

interface RebaseBranchDialogProps {
  sourceBranch: string
  currentBranch: string
  isRebasing: boolean
  rebaseResult: GitRebaseResult | null
  onConfirm: () => void
  onAbort: () => void
  onContinue: () => void
  onClose: () => void
}

export function RebaseBranchDialog({
  sourceBranch,
  currentBranch,
  isRebasing,
  rebaseResult,
  onConfirm,
  onAbort,
  onContinue,
  onClose,
}: RebaseBranchDialogProps) {
  const { t } = useTranslation('git')

  const handleClose = () => {
    if (!isRebasing) {
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">
            {t('branch.rebase')}
          </h2>
          <button
            onClick={handleClose}
            disabled={isRebasing}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          <div className="px-4 py-3 bg-primary/5 border border-primary/20 rounded-lg">
            <div className="text-sm text-text-secondary mb-1">{t('branch.rebaseCurrentBranch')}</div>
            <div className="flex items-center gap-2">
              <Check size={14} className="text-primary" />
              <span className="text-sm font-medium text-text-primary">{currentBranch}</span>
              <span className="text-xs px-1.5 py-0.5 bg-primary/20 text-primary rounded">
                {t('branch.current')}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-center text-text-tertiary">
            <span className="text-2xl">↓</span>
          </div>

          <div className="px-4 py-3 bg-background-surface border border-border rounded-lg">
            <div className="text-sm text-text-secondary mb-1">{t('branch.rebaseOnto')}</div>
            <div className="flex items-center gap-2">
              <GitBranchIcon size={14} className="text-info" />
              <span className="text-sm font-medium text-text-primary">{sourceBranch}</span>
            </div>
          </div>

          {rebaseResult?.hasConflicts && (
            <div className="px-3 py-2 bg-warning/10 border border-warning/30 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertCircle size={16} className="text-warning shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-warning">
                    {t('branch.rebaseConflicts')}
                  </div>
                  <div className="text-xs text-warning/70 mt-1">
                    {t('branch.rebaseConflictsDesc', { count: rebaseResult.conflicts.length })}
                  </div>
                  <div className="mt-2 max-h-24 overflow-y-auto">
                    {rebaseResult.conflicts.map((file, idx) => (
                      <div key={idx} className="text-xs text-text-tertiary font-mono">
                        {file}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {rebaseResult && !rebaseResult.finished && !rebaseResult.hasConflicts && (
            <div className="px-3 py-2 bg-info/10 border border-info/30 rounded-lg">
              <div className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin text-info" />
                <span className="text-sm text-info">
                  {t('branch.rebaseProgress', { current: rebaseResult.currentStep, total: rebaseResult.totalSteps })}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          {rebaseResult?.hasConflicts ? (
            <>
              <button
                onClick={onAbort}
                disabled={isRebasing}
                className="px-4 py-2 text-sm text-danger hover:bg-danger/10 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                <Square size={14} />
                {t('branch.rebaseAbort')}
              </button>
              <button
                onClick={onContinue}
                disabled={isRebasing}
                className="px-4 py-2 text-sm bg-info text-white rounded-lg hover:bg-info/90 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {isRebasing && <Loader2 size={14} className="animate-spin" />}
                <Play size={14} />
                {t('branch.rebaseContinue')}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleClose}
                disabled={isRebasing}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
              >
                {t('cancel', { ns: 'common' })}
              </button>
              <button
                onClick={onConfirm}
                disabled={isRebasing}
                className="px-4 py-2 text-sm bg-info text-white rounded-lg hover:bg-info/90 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {isRebasing && <Loader2 size={14} className="animate-spin" />}
                <GitCompare size={14} />
                {t('branch.rebase')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
