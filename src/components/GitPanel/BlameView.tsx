/**
 * Blame 视图组件
 *
 * 显示文件的 Git Blame 信息
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Loader2, FileText, GitCommit, User, Clock, AlertCircle } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useToastStore } from '@/stores/toastStore'
import type { GitBlameLine } from '@/types/git'

interface BlameViewProps {
  filePath: string
  onClose: () => void
  onCommitClick?: (commitSha: string) => void
}

export function BlameView({ filePath, onClose, onCommitClick }: BlameViewProps) {
  const { t } = useTranslation('git')
  const [lines, setLines] = useState<GitBlameLine[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const blameFile = useGitStore((s) => s.blameFile)
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId } = s
    return workspaces.find(w => w.id === currentWorkspaceId) || null
  })
  const toast = useToastStore()

  const loadBlame = useCallback(async () => {
    if (!currentWorkspace) return

    setIsLoading(true)
    setError(null)

    try {
      const result = await blameFile(currentWorkspace.path, filePath)
      setLines(result.lines)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      toast.error(t('blame.loadFailed'))
    } finally {
      setIsLoading(false)
    }
  }, [currentWorkspace, filePath, blameFile, toast, t])

  useEffect(() => {
    loadBlame()
  }, [loadBlame])

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp * 1000)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))

    if (days === 0) {
      return t('history.justNow')
    } else if (days < 7) {
      return t('history.daysAgo', { count: days })
    } else if (days < 30) {
      return t('history.daysAgo', { count: days })
    } else {
      return date.toLocaleDateString()
    }
  }

  // 按提交分组，用于显示不同的背景色
  const getCommitColor = (index: number, lines: GitBlameLine[]): number => {
    if (index === 0) return 0
    if (lines[index].commitSha !== lines[index - 1].commitSha) {
      return (getCommitColor(index - 1, lines) + 1) % 2
    }
    return getCommitColor(index - 1, lines)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-surface border border-border-subtle rounded-lg shadow-lg w-[90vw] max-w-[1200px] h-[85vh] flex flex-col">
        {/* 标题栏 */}
        <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <FileText size={16} className="text-primary" />
            <span className="text-sm font-medium text-text-primary">
              {t('blame.title')}: {filePath}
            </span>
            {lines.length > 0 && (
              <span className="text-xs text-text-tertiary">
                ({lines.length} {t('blame.lines')})
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 text-text-tertiary hover:text-text-primary rounded transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 size={24} className="animate-spin text-text-tertiary" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
              <AlertCircle size={32} className="mb-2 text-danger" />
              <span className="text-sm">{error}</span>
              <button
                onClick={loadBlame}
                className="mt-3 text-xs text-primary hover:underline"
              >
                {t('refresh', { ns: 'common' })}
              </button>
            </div>
          ) : lines.length === 0 ? (
            <div className="flex items-center justify-center h-full text-text-tertiary">
              <span className="text-sm">{t('blame.empty')}</span>
            </div>
          ) : (
            <div className="font-mono text-xs">
              {lines.map((line, index) => {
                const colorGroup = getCommitColor(index, lines)
                const isFirstOfGroup = index === 0 || lines[index].commitSha !== lines[index - 1].commitSha

                return (
                  <div
                    key={index}
                    className={`flex hover:bg-primary/5 ${
                      colorGroup === 0 ? 'bg-background' : 'bg-background-hover/30'
                    }`}
                  >
                    {/* 行号 */}
                    <div className="w-12 py-1 px-2 text-right text-text-tertiary border-r border-border-subtle select-none shrink-0">
                      {line.lineNumber}
                    </div>

                    {/* Blame 信息 */}
                    <div
                      className={`w-64 py-1 px-3 border-r border-border-subtle shrink-0 ${
                        isFirstOfGroup ? '' : 'opacity-50'
                      }`}
                    >
                      {isFirstOfGroup ? (
                        <div className="flex flex-col gap-0.5 truncate">
                          <div className="flex items-center gap-1.5">
                            <GitCommit size={10} className="text-text-tertiary shrink-0" />
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                onCommitClick?.(line.commitSha)
                              }}
                              className="text-text-secondary hover:text-primary truncate font-sans cursor-pointer hover:underline"
                              title={t('blame.viewCommit')}
                            >
                              {line.shortSha}
                            </button>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <User size={10} className="text-text-tertiary shrink-0" />
                            <span className="text-text-tertiary truncate font-sans">
                              {line.author}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Clock size={10} className="text-text-tertiary shrink-0" />
                            <span className="text-text-tertiary truncate font-sans">
                              {formatTime(line.timestamp)}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <span className="text-text-tertiary">│</span>
                      )}
                    </div>

                    {/* 代码内容 */}
                    <div className="py-1 px-3 flex-1 whitespace-pre overflow-x-auto">
                      {line.content || ' '}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 底部栏 */}
        <div className="px-4 py-2 border-t border-border-subtle flex items-center justify-between text-xs text-text-tertiary shrink-0">
          <div className="flex items-center gap-4">
            <span>{t('blame.hint')}</span>
          </div>
          <button
            onClick={onClose}
            className="px-3 py-1 bg-background-hover text-text-secondary rounded hover:bg-background-surface transition-colors"
          >
            {t('close', { ns: 'common' })}
          </button>
        </div>
      </div>
    </div>
  )
}
