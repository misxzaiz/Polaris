/**
 * 在特定提交上创建标签的弹窗
 *
 * 复用 tagSlice.createTag，预填 commit SHA
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tag, Loader2, X } from 'lucide-react'
import type { GitCommit as GitCommitType } from '@/types/git'
import { useGitStore } from '@/stores/gitStore/index'
import { useToastStore } from '@/stores/toastStore'
import { parseGitError } from '@/stores/gitStore'

interface CreateTagFromCommitDialogProps {
  commit: GitCommitType
  workspacePath: string
  onClose: () => void
  onSuccess: () => void
}

export function CreateTagFromCommitDialog({
  commit,
  workspacePath,
  onClose,
  onSuccess,
}: CreateTagFromCommitDialogProps) {
  const { t } = useTranslation('git')
  const createTag = useGitStore((s) => s.createTag)
  const toast = useToastStore()
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const handleConfirm = async () => {
    if (!name.trim()) return
    setIsCreating(true)
    try {
      await createTag(workspacePath, name.trim(), commit.sha, message.trim() || undefined)
      toast.success(t('tags.createSuccess', { name: name.trim() }))
      onSuccess()
    } catch (err) {
      toast.error(t('tags.createFailed', { error: parseGitError(err) }))
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
            {t('tags.createTag')}
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
              {t('tags.tagName')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && message) handleConfirm() }}
              placeholder={t('tags.tagNamePlaceholder')}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1.5">
              {t('tags.tagMessage')}
            </label>
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('tags.tagMessagePlaceholder')}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
            />
            <p className="text-xs text-text-tertiary mt-1">
              {t('tags.tagMessageHint')}
            </p>
          </div>

          <div className="text-xs text-text-tertiary">
            {t('tags.targetCommit')}: {commit.shortSha}
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
            <Tag size={14} />
            {t('tags.createTag')}
          </button>
        </div>
      </div>
    </div>
  )
}