/**
 * Tags 列表组件
 *
 * 显示 Git 标签列表，支持创建和删除标签
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Tag, RefreshCw, Loader2, Inbox, Copy, GitCommit, Plus, Trash2, X, MessageSquare } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useToastStore } from '@/stores/toastStore'
import { formatGitTimestamp } from '@/utils/gitFormat'
import type { GitTag } from '@/types/git'

export function TagsTab() {
  const { t } = useTranslation('git')
  const [tags, setTags] = useState<GitTag[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 创建标签状态
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [newTagMessage, setNewTagMessage] = useState('')
  const [newTagCommitish, setNewTagCommitish] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // 删除标签状态
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [tagToDelete, setTagToDelete] = useState<GitTag | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const getTags = useGitStore((s) => s.getTags)
  const createTag = useGitStore((s) => s.createTag)
  const deleteTag = useGitStore((s) => s.deleteTag)
  const status = useGitStore((s) => s.status)
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId } = s
    return workspaces.find(w => w.id === currentWorkspaceId) || null
  })
  const toast = useToastStore()

  const loadTags = useCallback(async () => {
    if (!currentWorkspace) return

    setIsLoading(true)
    setError(null)
    try {
      const result = await getTags(currentWorkspace.path)
      setTags(result)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
    } finally {
      setIsLoading(false)
    }
  }, [currentWorkspace, getTags])

  useEffect(() => {
    loadTags()
  }, [loadTags])

  // 优化：使用 Set 缓存标签名，实现 O(1) 查找
  const tagNamesSet = useMemo(() => new Set(tags.map(t => t.name)), [tags])

  // 打开创建标签弹窗
  const handleOpenCreateModal = () => {
    setNewTagName('')
    setNewTagMessage('')
    setNewTagCommitish('') // 默认使用 HEAD
    setCreateError(null)
    setShowCreateModal(true)
  }

  // 验证标签名
  const validateTagName = (name: string): boolean => {
    if (!name.trim()) return false
    const invalidChars = /[\s~^:?*[\\]/
    return !invalidChars.test(name)
  }

  // 创建标签
  const handleCreateTag = async () => {
    if (!currentWorkspace) return

    // 验证标签名
    if (!newTagName.trim()) {
      setCreateError(t('tags.nameRequired'))
      return
    }

    if (!validateTagName(newTagName)) {
      setCreateError(t('tags.invalidName'))
      return
    }

    // 检查标签是否已存在（使用 Set 进行 O(1) 查找）
    if (tagNamesSet.has(newTagName)) {
      setCreateError(t('tags.alreadyExists'))
      return
    }

    setIsCreating(true)
    setCreateError(null)

    try {
      await createTag(
        currentWorkspace.path,
        newTagName.trim(),
        newTagCommitish.trim() || undefined,
        newTagMessage.trim() || undefined
      )
      toast.success(t('tags.createSuccess', { name: newTagName }))
      setShowCreateModal(false)
      await loadTags()
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setCreateError(errorMsg)
    } finally {
      setIsCreating(false)
    }
  }

  // 打开删除确认弹窗
  const handleOpenDeleteModal = (tag: GitTag) => {
    setTagToDelete(tag)
    setShowDeleteModal(true)
  }

  // 删除标签
  const handleDeleteTag = async () => {
    if (!currentWorkspace || !tagToDelete) return

    setIsDeleting(true)

    try {
      await deleteTag(currentWorkspace.path, tagToDelete.name)
      toast.success(t('tags.deleteSuccess', { name: tagToDelete.name }))
      setShowDeleteModal(false)
      setTagToDelete(null)
      await loadTags()
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(errorMsg)
    } finally {
      setIsDeleting(false)
    }
  }

  const handleCopySha = async (sha: string) => {
    try {
      await navigator.clipboard.writeText(sha)
      toast.success(t('tags.shaCopied'))
    } catch {
      toast.error(t('tags.copyFailed'))
    }
  }

  // 使用共享的时间格式化函数
  const formatTime = (timestamp?: number) => {
    if (!timestamp) return ''
    return formatGitTimestamp(timestamp, t)
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between">
        <span className="text-sm font-medium text-text-primary">{t('tags.title')}</span>
        <div className="flex items-center gap-2">
          {tags.length > 0 && (
            <span className="text-xs text-text-tertiary">{t('tags.count', { count: tags.length })}</span>
          )}
          <button
            onClick={handleOpenCreateModal}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
            title={t('tags.createTag')}
          >
            <Plus size={14} />
          </button>
          <button
            onClick={loadTags}
            disabled={isLoading}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
            title={t('refresh', { ns: 'common' })}
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-danger bg-danger/10 border-b border-danger/20">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {isLoading && tags.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-text-tertiary" />
          </div>
        ) : tags.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
            <Inbox size={24} className="mb-2 opacity-50" />
            <span className="text-sm">{t('tags.empty')}</span>
            <button
              onClick={handleOpenCreateModal}
              className="mt-3 text-xs text-primary hover:underline"
            >
              {t('tags.createFirst')}
            </button>
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {tags.map((tag) => (
              <div
                key={tag.name}
                className="px-4 py-3 hover:bg-background-hover transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
                    <Tag size={12} className="text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-text-primary truncate">
                        {tag.name}
                      </span>
                      {!tag.isLightweight && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-info/10 text-info rounded">
                          {t('tags.annotated')}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-text-tertiary">
                      <GitCommit size={10} />
                      <span className="font-mono">{tag.shortSha}</span>
                    </div>
                    {tag.message && (
                      <div className="text-xs text-text-secondary mt-1 truncate">
                        {tag.message}
                      </div>
                    )}
                    {(tag.tagger || tag.timestamp) && (
                      <div className="text-xs text-text-tertiary mt-1">
                        {tag.tagger && <span>{tag.tagger}</span>}
                        {tag.tagger && tag.timestamp && <span> · </span>}
                        {tag.timestamp && <span>{formatTime(tag.timestamp)}</span>}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleCopySha(tag.commitSha)}
                      className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-background-surface rounded transition-colors"
                      title={t('tags.copySha')}
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      onClick={() => handleOpenDeleteModal(tag)}
                      className="p-1.5 text-text-tertiary hover:text-danger hover:bg-danger/10 rounded transition-colors"
                      title={t('tags.deleteTag')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 创建标签弹窗 */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-surface border border-border-subtle rounded-lg shadow-lg w-[400px] max-w-[90vw]">
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
              <span className="text-sm font-medium text-text-primary">{t('tags.createTag')}</span>
              <button
                onClick={() => setShowCreateModal(false)}
                className="p-1 text-text-tertiary hover:text-text-primary rounded transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4 space-y-4">
              {/* 标签名 */}
              <div>
                <label className="block text-xs text-text-secondary mb-1">
                  {t('tags.tagName')} <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  placeholder={t('tags.tagNamePlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-background border border-border-subtle rounded focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-tertiary"
                  autoFocus
                />
              </div>

              {/* 目标提交（可选） */}
              <div>
                <label className="block text-xs text-text-secondary mb-1">
                  {t('tags.targetCommit')}
                </label>
                <input
                  type="text"
                  value={newTagCommitish}
                  onChange={(e) => setNewTagCommitish(e.target.value)}
                  placeholder={t('tags.targetCommitPlaceholder', { head: status?.shortCommit || 'HEAD' })}
                  className="w-full px-3 py-2 text-sm bg-background border border-border-subtle rounded focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-tertiary"
                />
                <p className="text-xs text-text-tertiary mt-1">{t('tags.targetCommitHint')}</p>
              </div>

              {/* 标签消息（可选，用于 annotated tag） */}
              <div>
                <label className="block text-xs text-text-secondary mb-1 flex items-center gap-1">
                  <MessageSquare size={10} />
                  {t('tags.tagMessage')}
                </label>
                <textarea
                  value={newTagMessage}
                  onChange={(e) => setNewTagMessage(e.target.value)}
                  placeholder={t('tags.tagMessagePlaceholder')}
                  rows={3}
                  className="w-full px-3 py-2 text-sm bg-background border border-border-subtle rounded focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-tertiary resize-none"
                />
                <p className="text-xs text-text-tertiary mt-1">{t('tags.tagMessageHint')}</p>
              </div>

              {/* 错误提示 */}
              {createError && (
                <div className="px-3 py-2 text-xs text-danger bg-danger/10 rounded">
                  {createError}
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-border-subtle flex justify-end gap-2">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                {t('cancel', { ns: 'common' })}
              </button>
              <button
                onClick={handleCreateTag}
                disabled={isCreating || !newTagName.trim()}
                className="px-3 py-1.5 text-sm bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isCreating ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  t('tags.createTag')
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {showDeleteModal && tagToDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-surface border border-border-subtle rounded-lg shadow-lg w-[360px] max-w-[90vw]">
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
              <span className="text-sm font-medium text-text-primary">{t('tags.deleteTag')}</span>
              <button
                onClick={() => setShowDeleteModal(false)}
                className="p-1 text-text-tertiary hover:text-text-primary rounded transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4">
              <p className="text-sm text-text-secondary">
                {t('tags.deleteConfirm', { name: tagToDelete.name })}
              </p>
              {tagToDelete.isLightweight && (
                <p className="text-xs text-text-tertiary mt-2">
                  {t('tags.lightweightTagHint')}
                </p>
              )}
            </div>
            <div className="px-4 py-3 border-t border-border-subtle flex justify-end gap-2">
              <button
                onClick={() => setShowDeleteModal(false)}
                className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                {t('cancel', { ns: 'common' })}
              </button>
              <button
                onClick={handleDeleteTag}
                disabled={isDeleting}
                className="px-3 py-1.5 text-sm bg-danger text-white rounded hover:bg-danger/90 transition-colors disabled:opacity-50"
              >
                {isDeleting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  t('delete', { ns: 'common' })
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
