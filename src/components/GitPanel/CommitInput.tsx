/**
 * 提交输入组件
 *
 * 输入提交消息
 */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, Sparkles, Loader2 } from 'lucide-react'
import { Button } from '@/components/Common/Button'
import { useGitStore } from '@/stores/gitStore/index'
import { useWorkspaceStore } from '@/stores'
import { generateCommitMessage } from '@/services/commitMessageGenerator'
import { logger } from '@/utils/logger'
import type { GitDiffEntry } from '@/types/git'

interface CommitInputProps {
  hasChanges?: boolean
  selectedFiles?: Set<string>
}

export function CommitInput({ hasChanges: _hasChanges, selectedFiles }: CommitInputProps) {
  const { t } = useTranslation('git')
  const [message, setMessage] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const { commitChanges, isLoading, status, getIndexFileDiff, getWorktreeFileDiff } = useGitStore()
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId } = s
    return workspaces.find(w => w.id === currentWorkspaceId) || null
  })

  const handleCommit = useCallback(async () => {
    if (!message.trim() || !currentWorkspace) return

    if (!currentWorkspace.path || currentWorkspace.path.trim() === '') {
      logger.error('[CommitInput] Invalid workspace path')
      return
    }

    const reservedNames = ['nul', 'con', 'prn', 'aux', 'com1', 'com2', 'com3', 'com4', 'lpt1', 'lpt2', 'lpt3']
    const pathLower = currentWorkspace.path.toLowerCase()
    if (reservedNames.some(name => pathLower.includes(name))) {
      logger.error('[CommitInput] Path contains Windows reserved name')
      return
    }

    try {
      const hasSelectedFiles = selectedFiles && selectedFiles.size > 0
      const filesToCommit = hasSelectedFiles ? Array.from(selectedFiles) : undefined

      // 始终传递 stageAll=true，后端会根据 selectedFiles 决定暂存哪些
      await commitChanges(currentWorkspace.path, message, true, filesToCommit)
      setMessage('')
    } catch (err) {
      logger.error('[CommitInput] Commit failed:', err)
    }
  }, [message, currentWorkspace, selectedFiles, commitChanges])

  const handleGenerateMessage = useCallback(async () => {
    if (!currentWorkspace || isGenerating) return

    setIsGenerating(true)
    try {
      let diffsToAnalyze: GitDiffEntry[] | undefined

      if (selectedFiles && selectedFiles.size > 0) {
        // 获取选中文件的 diff
        diffsToAnalyze = []
        for (const filePath of Array.from(selectedFiles)) {
          try {
            const diff = await getIndexFileDiff(currentWorkspace.path, filePath)
            diffsToAnalyze.push(diff)
          } catch {
            try {
              const diff = await getWorktreeFileDiff(currentWorkspace.path, filePath)
              diffsToAnalyze.push(diff)
            } catch {
              // 忽略获取失败的文件
            }
          }
        }
      }

      const generatedMessage = await generateCommitMessage({
        workspacePath: currentWorkspace.path,
        stagedDiffs: diffsToAnalyze,
      })
      setMessage(generatedMessage)
    } catch (err) {
      logger.error('[CommitInput] Failed to generate commit message:', err)
      if (status?.staged.length) {
        setMessage(`chore: update ${status.staged.length} files`)
      }
    } finally {
      setIsGenerating(false)
    }
  }, [currentWorkspace, isGenerating, selectedFiles, status?.staged.length, getIndexFileDiff, getWorktreeFileDiff])

  const hasStagedFiles = (status?.staged.length ?? 0) > 0
  const hasSelectedFiles = selectedFiles && selectedFiles.size > 0
  const canCommit = message.trim() && (hasStagedFiles || hasSelectedFiles)

  const getCommitHint = () => {
    if (hasSelectedFiles && selectedFiles) {
      return t('commit.selectedFiles', { count: selectedFiles.size })
    }
    if (hasStagedFiles) {
      return t('commit.stagedFiles', { count: status?.staged.length ?? 0 })
    }
    return t('commit.noFiles')
  }

  return (
    <div className="px-4 py-3 border-t border-border-subtle space-y-2">
      <div className="relative">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t('commit.placeholder')}
          className="w-full px-3 py-2 pr-10 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary resize-none"
          rows={3}
          disabled={isLoading || isGenerating}
        />
        
        <button
          onClick={handleGenerateMessage}
          disabled={isGenerating || isLoading || !status || (status.staged.length === 0 && status.unstaged.length === 0 && selectedFiles?.size === 0)}
          className="absolute right-2 top-2 p-1.5 text-text-tertiary hover:text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={t('commit.generateWithAI')}
        >
          {isGenerating ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Sparkles size={14} />
          )}
        </button>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-text-tertiary">
          {getCommitHint()}
        </span>
        
        <Button
          size="sm"
          variant="primary"
          onClick={handleCommit}
          disabled={!canCommit || isLoading}
        >
          <Send size={14} />
          {t('commit.button')}
        </Button>
      </div>
    </div>
  )
}
