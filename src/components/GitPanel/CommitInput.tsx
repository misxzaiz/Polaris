/**
 * 提交输入组件
 *
 * 输入提交消息。
 * "AI 生成提交信息"改为：选择引擎后在右侧 AI 面板新建/复用会话，
 * 把选中变更作为上下文自动发送；AI 输出可通过"采用"按钮回流到提交输入框。
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, Sparkles, Loader2, Bot, Cpu, Zap, Check, MessageSquare } from 'lucide-react'
import { clsx } from 'clsx'
import { Button } from '@/components/Common/Button'
import { useGitStore } from '@/stores/gitStore/index'
import { useWorkspaceStore, useConfigStore, useViewStore } from '@/stores'
import { invoke } from '@/services/transport'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { openCommitMessageChat, useCommitMessageSuggestion } from '@/services/commitMessageChat'
import { normalizeEngineId, getEngineFullName } from '@/utils/engineDisplay'
import { logger } from '@/utils/logger'
import type { EngineId } from '@/types'
import type { GitDiffEntry } from '@/types/git'

const COMMIT_ENGINE_STORAGE_KEY = 'polaris.git.commitEngine'

const ENGINE_OPTIONS: Array<{ id: EngineId; label: string; Icon: typeof Bot }> = [
  { id: 'claude-code', label: 'Claude', Icon: Bot },
  { id: 'codex', label: 'Codex', Icon: Cpu },
  { id: 'simple-ai', label: 'Simple', Icon: Zap },
  { id: 'mimo', label: 'Mimo', Icon: Sparkles },
]

function readStoredEngine(defaultEngine: EngineId): EngineId {
  try {
    const raw = localStorage.getItem(COMMIT_ENGINE_STORAGE_KEY)
    if (raw) {
      const normalized = normalizeEngineId(raw)
      if (ENGINE_OPTIONS.some((o) => o.id === normalized)) return normalized
    }
  } catch {
    // localStorage 不可用时静默回退
  }
  return defaultEngine
}

interface CommitInputProps {
  hasChanges?: boolean
  selectedFiles?: Set<string>
}

export function CommitInput({ hasChanges: _hasChanges, selectedFiles }: CommitInputProps) {
  const { t } = useTranslation('git')
  const [message, setMessage] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [enginePickerOpen, setEnginePickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const sparkleButtonRef = useRef<HTMLButtonElement>(null)

  const { commitChanges, isLoading, status, getIndexFileDiff, getWorktreeFileDiff } = useGitStore()
  const defaultEngine = normalizeEngineId(useConfigStore((s) => s.config?.defaultEngine))
  const [selectedEngine, setSelectedEngine] = useState<EngineId>(() => readStoredEngine(defaultEngine))
  const toggleRightPanel = useViewStore((s) => s.toggleRightPanel)
  const rightPanelCollapsed = useViewStore((s) => s.rightPanelCollapsed)

  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId } = s
    return workspaces.find(w => w.id === currentWorkspaceId) || null
  })

  // 订阅本工作区 commit-message 会话的最新助手消息（回流条）
  const suggestion = useCommitMessageSuggestion(currentWorkspace?.id)

  // 默认引擎变化时同步（用户未手动选过则跟随全局）
  useEffect(() => {
    const stored = readStoredEngine(defaultEngine)
    setSelectedEngine((prev) => (prev === stored ? prev : stored))
  }, [defaultEngine])

  // 点击外部关闭引擎选择浮层
  useEffect(() => {
    if (!enginePickerOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (
        pickerRef.current && !pickerRef.current.contains(e.target as Node) &&
        sparkleButtonRef.current && !sparkleButtonRef.current.contains(e.target as Node)
      ) {
        setEnginePickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [enginePickerOpen])

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

  // 收集 diff 上下文并在右侧面板打开 commit-message 会话
  const handleGenerateWithEngine = useCallback(async (engineId: EngineId) => {
    setEnginePickerOpen(false)
    if (!currentWorkspace || isGenerating) return

    setIsGenerating(true)
    try {
      let diffs: GitDiffEntry[] = []

      if (selectedFiles && selectedFiles.size > 0) {
        // 获取选中文件的 diff
        for (const filePath of Array.from(selectedFiles)) {
          try {
            diffs.push(await getIndexFileDiff(currentWorkspace.path, filePath))
          } catch {
            try {
              diffs.push(await getWorktreeFileDiff(currentWorkspace.path, filePath))
            } catch {
              // 忽略获取失败的文件
            }
          }
        }
      } else {
        // 无选中文件时取全部暂存变更
        diffs = await invoke<GitDiffEntry[]>('git_get_index_diff', {
          workspacePath: currentWorkspace.path,
        })
      }

      if (diffs.length === 0) {
        logger.warn('[CommitInput] No changes to analyze')
        return
      }

      await openCommitMessageChat({
        workspaceId: currentWorkspace.id,
        workspacePath: currentWorkspace.path,
        engineId,
        diffs,
      })
    } catch (err) {
      logger.error('[CommitInput] Failed to open commit message chat:', err)
    } finally {
      setIsGenerating(false)
    }
  }, [currentWorkspace, isGenerating, selectedFiles, getIndexFileDiff, getWorktreeFileDiff])

  const handlePickEngine = useCallback((engineId: EngineId) => {
    setSelectedEngine(engineId)
    try {
      localStorage.setItem(COMMIT_ENGINE_STORAGE_KEY, engineId)
    } catch {
      // localStorage 不可用时静默
    }
    void handleGenerateWithEngine(engineId)
  }, [handleGenerateWithEngine])

  const handleAdoptSuggestion = useCallback(() => {
    if (suggestion.text) {
      setMessage(suggestion.text)
    }
  }, [suggestion.text])

  const handleOpenSession = useCallback(() => {
    if (!suggestion.sessionId) return
    if (rightPanelCollapsed) toggleRightPanel()
    sessionStoreManager.getState().switchSession(suggestion.sessionId)
  }, [suggestion.sessionId, rightPanelCollapsed, toggleRightPanel])

  const hasStagedFiles = (status?.staged.length ?? 0) > 0
  const hasSelectedFiles = selectedFiles && selectedFiles.size > 0
  const canCommit = message.trim() && (hasStagedFiles || hasSelectedFiles)
  const canGenerate = !isGenerating && !isLoading && !!status &&
    (status.staged.length > 0 || status.unstaged.length > 0 || (selectedFiles?.size ?? 0) > 0)

  // AI 建议（含流式中）
  const showSuggestion = Boolean(suggestion.sessionId && suggestion.text)

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
    <div className="px-3 py-2 border-t border-border-subtle space-y-1.5">
      {/* AI 建议回流条 */}
      {showSuggestion && (
        <div className="flex items-start gap-2 p-2 rounded-lg bg-primary/5 border border-primary/20">
          <Sparkles size={14} className="text-primary shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-primary">
                {t('commit.aiSuggestion')}
              </span>
              {suggestion.isStreaming && (
                <Loader2 size={11} className="animate-spin text-primary" />
              )}
            </div>
            <p className="text-xs text-text-secondary mt-0.5 line-clamp-2 break-all">
              {suggestion.text}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleAdoptSuggestion}
              disabled={suggestion.isStreaming}
              className="flex items-center gap-1 px-2 py-1 text-[11px] text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-50"
              title={t('commit.adopt')}
            >
              <Check size={12} />
              {t('commit.adopt')}
            </button>
            <button
              onClick={handleOpenSession}
              className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
              title={t('commit.openSession')}
            >
              <MessageSquare size={12} />
            </button>
          </div>
        </div>
      )}

      <div className="relative">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t('commit.placeholder')}
          className="w-full px-3 py-1.5 pr-10 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary resize-none"
          rows={2}
          disabled={isLoading || isGenerating}
        />

        <button
          ref={sparkleButtonRef}
          onClick={() => setEnginePickerOpen((v) => !v)}
          disabled={!canGenerate}
          className="absolute right-2 top-2 p-1.5 text-text-tertiary hover:text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={t('commit.generateWithAI')}
        >
          {isGenerating ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Sparkles size={14} />
          )}
        </button>

        {/* 引擎选择浮层 */}
        {enginePickerOpen && (
          <div
            ref={pickerRef}
            className="absolute right-0 top-full mt-1 z-50 min-w-[180px] py-1 rounded-lg shadow-lg bg-background-elevated border border-border"
          >
            <div className="px-2 pb-1.5 text-[11px] font-medium text-text-tertiary">
              {t('commit.selectEngine')}
            </div>
            {ENGINE_OPTIONS.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => handlePickEngine(id)}
                className={clsx(
                  'w-full flex items-center gap-2 px-2.5 py-1.5 text-xs transition-colors',
                  selectedEngine === id
                    ? 'text-primary bg-primary/10'
                    : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
                )}
                title={getEngineFullName(id)}
              >
                <Icon className="w-3.5 h-3.5" />
                <span className="flex-1 text-left">{label}</span>
                {selectedEngine === id && <Check size={12} />}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between min-h-7">
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
