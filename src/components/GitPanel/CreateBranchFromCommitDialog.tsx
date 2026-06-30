/**
 * 从特定提交创建分支的弹窗
 *
 * 复用了 CreateBranchDialog 的 UI 风格，但绑定到了指定 commit SHA
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch as GitBranchIcon, Loader2, X } from 'lucide-react'
import type { GitCommit as GitCommitType } from '@/types/git'
import { useGitStore } from '@/stores/gitStore/index'
import { useToastStore } from '@/stores/toastStore'
import { parseGitError } from '@/stores/gitStore'

interface CreateBranchFromCommitDialogProps {
  commit: GitCommitType
  workspacePath: string
  onClose: () => void
  onSuccess: () => void
}

export function CreateBranchFromCommitDialog({
  commit,
  workspacePath,
  onClose,
  onSuccess,
}: CreateBranchFromCommitDialogProps) {
  const { t } = useTranslation('git')
  const createBranch = useGitStore((s) => s.createBranch)
  const toast = useToastStore()
  const [name, setName] = useState('')
  const [checkout, setCheckout] = useState(false)
  const [isCreating, setIsCreating] = useState(false)

  const handleConfirm = async () => {
    if (!name.trim()) return
    setIsCreating(true)
    try {
      await createBranch(workspacePath, name.trim(), checkout, commit.sha)
      toast.success(t('branch.createSuccess', { branch: name.trim() }))
      onSuccess()
    } catch (err) {
      toast.error(t('branch.createBranchFailed', { error: parseGitError(err) }))
      setIsCreating(false)
    }
  }

  const handleClose = () => {
    if (!isCreating) {
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">
            {t('history.createBranch')}
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
            {t('branch.createFrom', { branch: commit.shortSha })}
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
            <GitBranchIcon size={14} />
            {t('branch.create')}
          </button>
        </div>
      </div>
    </div>
  )
}