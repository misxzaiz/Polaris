/**
 * Tags 列表组件
 *
 * 显示 Git 标签列表
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Tag, RefreshCw, Loader2, Inbox, Copy, GitCommit } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useToastStore } from '@/stores/toastStore'
import type { GitTag } from '@/types/git'

export function TagsTab() {
  const { t } = useTranslation('git')
  const [tags, setTags] = useState<GitTag[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const getTags = useGitStore((s) => s.getTags)
  const currentWorkspace = useWorkspaceStore((s) => s.getCurrentWorkspace())
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

  const handleCopySha = async (sha: string) => {
    try {
      await navigator.clipboard.writeText(sha)
      toast.success(t('tags.shaCopied'))
    } catch {
      toast.error(t('tags.copyFailed'))
    }
  }

  const formatTime = (timestamp?: number) => {
    if (!timestamp) return null
    const date = new Date(timestamp * 1000)
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between">
        <span className="text-sm font-medium text-text-primary">{t('tags.title')}</span>
        <div className="flex items-center gap-2">
          {tags.length > 0 && (
            <span className="text-xs text-text-tertiary">{t('tags.count', { count: tags.length })}</span>
          )}
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

      <div className="flex-1 overflow-y-auto">
        {isLoading && tags.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-text-tertiary" />
          </div>
        ) : tags.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
            <Inbox size={24} className="mb-2 opacity-50" />
            <span className="text-sm">{t('tags.empty')}</span>
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
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}