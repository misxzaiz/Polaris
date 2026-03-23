/**
 * 聊天输入组件 - 支持附件、斜杠命令、工作区引用和 Git 上下文
 *
 * 支持功能:
 * - 文本输入
 * - 文件/图片附件 (粘贴、拖放、选择)
 * - 命令触发 (/)
 * - 工作区引用 (@workspace)
 * - 文件引用 (@/path)
 * - Git 上下文 (@git)
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../Common'
import { IconSend, IconStop, IconPaperclip } from '../Common/Icons'
import { useWorkspaceStore, useConfigStore, useEventChatStore } from '../../stores'
import { FileSuggestion, WorkspaceSuggestion } from './FileSuggestion'
import { GitSuggestion, getGitRootSuggestions, commitsToSuggestionItems, type GitSuggestionItem } from './GitSuggestion'
import { AttachmentPreview } from './AttachmentPreview'
import { AutoResizingTextarea } from './AutoResizingTextarea'
import { useFileSearch } from '../../hooks/useFileSearch'
import { getGitCommits } from '../../services/gitContextService'
import { baiduTranslate } from '../../services/tauri'
import type { FileMatch } from '../../services/fileSearch'
import type { Workspace } from '../../types'
import type { Attachment } from '../../types/attachment'
import {
  createAttachment,
  validateAttachment,
  validateAttachments,
  isImageType,
} from '../../types/attachment'

interface ChatInputProps {
  onSend: (message: string, workspaceDir?: string, attachments?: Attachment[]) => void
  disabled?: boolean
  isStreaming?: boolean
  onInterrupt?: () => void
  currentWorkDir?: string | null
}

type SuggestionMode = 'workspace' | 'file' | 'git' | null

export function ChatInput({
  onSend,
  disabled = false,
  isStreaming = false,
  onInterrupt,
  currentWorkDir,
}: ChatInputProps) {
  const { t } = useTranslation('chat')
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 附件状态
  const [attachments, setAttachments] = useState<Attachment[]>([])

  // 工作区建议状态
  const [showWorkspaceSuggestions, setShowWorkspaceSuggestions] = useState(false)
  const [selectedWorkspaceIndex, setSelectedWorkspaceIndex] = useState(0)
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [workspacePosition, setWorkspacePosition] = useState({ top: 0, left: 0 })

  // 文件建议状态
  const [showFileSuggestions, setShowFileSuggestions] = useState(false)
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [filePosition, setFilePosition] = useState({ top: 0, left: 0 })
  const [fileWorkspace, setFileWorkspace] = useState<Workspace | null>(null)

  // Git 建议状态
  const [showGitSuggestions, setShowGitSuggestions] = useState(false)
  const [gitMode, setGitMode] = useState<'root' | 'commit'>('root')
  const [gitQuery, setGitQuery] = useState('')
  const [selectedGitIndex, setSelectedGitIndex] = useState(0)
  const [gitPosition, setGitPosition] = useState({ top: 0, left: 0 })
  const [gitCommits, setGitCommits] = useState<Array<{ hash: string; shortHash: string; message: string; author: string; timestamp: number }>>([])
  const [isGitLoading, setIsGitLoading] = useState(false)

  const { currentWorkspaceId, workspaces } = useWorkspaceStore()
  const { fileMatches, searchFiles, clearResults } = useFileSearch()
  const { config } = useConfigStore()

  // 检查是否有待回答的问题
  const hasPendingQuestion = useEventChatStore(state => {
    if (!state.currentMessage || !state.questionBlockMap.size) return false
    for (const blockIndex of state.questionBlockMap.values()) {
      const block = state.currentMessage.blocks[blockIndex]
      if (block?.type === 'question' && block.status === 'pending') {
        return true
      }
    }
    return false
  })

  const [isTranslating, setIsTranslating] = useState(false)

  // 过滤工作区列表
  const filteredWorkspaces = useMemo(
    () => workspaces.filter(w =>
      w.name.toLowerCase().includes(workspaceQuery.toLowerCase())
    ),
    [workspaces, workspaceQuery]
  )

  const gitSuggestions = useMemo(() => {
    if (gitMode === 'root') {
      return getGitRootSuggestions(t)
    }
    if (gitMode === 'commit' && gitQuery) {
      return commitsToSuggestionItems(gitCommits)
    }
    return gitCommits.length > 0 ? commitsToSuggestionItems(gitCommits) : []
  }, [gitMode, gitQuery, gitCommits, t])

  // 当前建议模式
  const suggestionMode: SuggestionMode = useMemo(() => {
    if (showWorkspaceSuggestions) return 'workspace'
    if (showFileSuggestions) return 'file'
    if (showGitSuggestions) return 'git'
    return null
  }, [showWorkspaceSuggestions, showFileSuggestions, showGitSuggestions])

  // 智能定位建议框
  const calculateSuggestionPosition = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return { top: 0, left: 0 }

    const rect = textarea.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const suggestionHeight = 260
    const shouldShowAbove = spaceBelow < suggestionHeight

    return {
      top: shouldShowAbove ? rect.top - suggestionHeight - 8 : rect.bottom + 8,
      left: rect.left,
    }
  }, [])

  // 添加附件
  const addAttachment = useCallback(async (file: File, source: 'paste' | 'drag' | 'select') => {
    // 验证
    const validation = validateAttachment(file)
    if (!validation.valid) {
      console.warn('[ChatInput] 附件验证失败:', validation.error)
      return
    }

    // 创建附件
    const attachment = await createAttachment(file, source)
    setAttachments(prev => {
      const newAttachments = [...prev, attachment]
      const totalValidation = validateAttachments(newAttachments)
      if (!totalValidation.valid) {
        console.warn('[ChatInput] 总附件验证失败:', totalValidation.error)
        return prev
      }
      return newAttachments
    })
  }, [])

  // 移除附件
  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  // 处理粘贴
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    let hasFiles = false

    for (const item of Array.from(items)) {
      // 图片
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          await addAttachment(file, 'paste')
          hasFiles = true
        }
      }
      // 文件
      else if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file && !isImageType(file.type)) {
          await addAttachment(file, 'paste')
          hasFiles = true
        }
      }
    }

    if (hasFiles) {
      e.preventDefault()
    }
  }, [addAttachment])

  // 处理拖放
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const files = Array.from(e.dataTransfer?.files || [])
    for (const file of files) {
      await addAttachment(file, 'drag')
    }
  }, [addAttachment])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  // 处理文件选择
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    for (const file of files) {
      await addAttachment(file, 'select')
    }
    // 清空 input 以便再次选择同一文件
    e.target.value = ''
  }, [addAttachment])

  // 打开文件选择
  const openFileDialog = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  // 检测触发符
  const handleInputChange = useCallback(async (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    setValue(newValue)

    const textarea = textareaRef.current
    if (!textarea || !containerRef.current) return

    const cursorPosition = textarea.selectionStart
    const textBeforeCursor = newValue.slice(0, cursorPosition)

    // 1. 检测 Git 上下文引用 (@git)
    const gitMatch = textBeforeCursor.match(/@git(?::(\w*))?(?:\s([^\s]*))?$/)
    if (gitMatch) {
      const gitAction = gitMatch[1] || ''
      const query = gitMatch[2] || ''

      setShowGitSuggestions(true)
      setShowWorkspaceSuggestions(false)
      setShowFileSuggestions(false)
      clearResults()

      if (gitAction === 'commit' || (!gitAction && query)) {
        setGitMode('commit')
        setGitQuery(query)
        setSelectedGitIndex(0)

        if (currentWorkDir && gitCommits.length === 0) {
          setIsGitLoading(true)
          try {
            const commits = await getGitCommits(currentWorkDir, { limit: 50 })
            setGitCommits(commits)
          } finally {
            setIsGitLoading(false)
          }
        }
      } else {
        setGitMode('root')
        setGitQuery('')
        setSelectedGitIndex(0)
      }

      const position = calculateSuggestionPosition()
      setGitPosition({ top: position.top, left: position.left })
      return
    }

    // 2. 检测跨工作区引用 (@workspace:path)
    const workspaceMatch = textBeforeCursor.match(/@([\w\u4e00-\u9fa5-]+):([^\s]*)$/)
    if (workspaceMatch) {
      const workspaceName = workspaceMatch[1]
      const pathPart = workspaceMatch[2] || ''

      const matchedWorkspace = workspaces.find(w =>
        w.name.toLowerCase() === workspaceName.toLowerCase()
      )

      if (matchedWorkspace) {
        setShowWorkspaceSuggestions(false)
        setShowFileSuggestions(true)
        setShowGitSuggestions(false)
        setFileWorkspace(matchedWorkspace)
        setSelectedFileIndex(0)
        searchFiles(pathPart, matchedWorkspace)
      } else {
        setShowWorkspaceSuggestions(true)
        setShowFileSuggestions(false)
        setShowGitSuggestions(false)
        setWorkspaceQuery(workspaceName)
        setSelectedWorkspaceIndex(0)
      }

      const position = calculateSuggestionPosition()
      setWorkspacePosition({ top: position.top, left: position.left })
      return
    }

    // 3. 检测用户正在输入工作区名
    const partialWorkspaceMatch = textBeforeCursor.match(/@([\w\u4e00-\u9fa5-]*)$/)
    if (partialWorkspaceMatch) {
      const workspaceName = partialWorkspaceMatch[1]
      if (workspaceName.length > 0 && workspaceName !== 'git') {
        setShowWorkspaceSuggestions(true)
        setShowFileSuggestions(false)
        setShowGitSuggestions(false)
        setWorkspaceQuery(workspaceName)
        setSelectedWorkspaceIndex(0)

        const position = calculateSuggestionPosition()
        setWorkspacePosition({ top: position.top, left: position.left })
        return
      }
    }

    // 4. 检测当前工作区文件引用 (@/path)
    const fileMatch = textBeforeCursor.match(/@\/(.*)$/)
    if (fileMatch) {
      setShowWorkspaceSuggestions(false)
      setShowFileSuggestions(true)
      setShowGitSuggestions(false)
      setFileWorkspace(null)
      setSelectedFileIndex(0)
      searchFiles(fileMatch[1])

      const position = calculateSuggestionPosition()
      setFilePosition({ top: position.top, left: position.left })
      return
    }

    // 隐藏所有建议
    setShowWorkspaceSuggestions(false)
    setShowFileSuggestions(false)
    setShowGitSuggestions(false)
    clearResults()
  }, [workspaces, searchFiles, clearResults, calculateSuggestionPosition, gitCommits, currentWorkDir])

  // 选择工作区
  const selectWorkspace = useCallback((workspace: Workspace) => {
    const textarea = textareaRef.current
    if (!textarea) return

    const cursorPosition = textarea.selectionStart
    const textBeforeCursor = value.slice(0, cursorPosition)
    const textAfterCursor = value.slice(cursorPosition)

    const newText = textBeforeCursor.replace(/@[\w\u4e00-\u9fa5-]*$/, `@${workspace.name}:`) + textAfterCursor
    setValue(newText)
    setShowWorkspaceSuggestions(false)

    setTimeout(() => {
      textarea.focus()
      const newCursorPos = newText.length - textAfterCursor.length
      textarea.setSelectionRange(newCursorPos, newCursorPos)
      const inputEvent = new Event('input', { bubbles: true })
      textarea.dispatchEvent(inputEvent)
    }, 0)
  }, [value])

  // 选择文件
  const selectFile = useCallback((file: FileMatch) => {
    const textarea = textareaRef.current
    if (!textarea) return

    const cursorPosition = textarea.selectionStart
    const textBeforeCursor = value.slice(0, cursorPosition)
    const textAfterCursor = value.slice(cursorPosition)

    let replacement: string
    if (fileWorkspace) {
      replacement = textBeforeCursor.replace(/@[\w\u4e00-\u9fa5-]+:[^\s]*$/, `@${fileWorkspace.name}:${file.relativePath} `)
    } else {
      replacement = textBeforeCursor.replace(/@\/[^\s]*$/, `@/${file.relativePath} `)
    }

    const newText = replacement + textAfterCursor
    setValue(newText)
    setShowFileSuggestions(false)

    setTimeout(() => {
      textarea.focus()
      textarea.setSelectionRange(newText.length - textAfterCursor.length, newText.length - textAfterCursor.length)
    }, 0)
  }, [value, fileWorkspace])

  // 选择 Git 建议
  const selectGitSuggestion = useCallback((item: GitSuggestionItem) => {
    const textarea = textareaRef.current
    if (!textarea) return

    const cursorPosition = textarea.selectionStart
    const textBeforeCursor = value.slice(0, cursorPosition)
    const textAfterCursor = value.slice(cursorPosition)

    let newText = ''
    if (item.type === 'action') {
      if (item.id === 'diff') {
        newText = textBeforeCursor.replace(/@git(?::\w*)?\s?[^\s]*$/, '@git:diff ') + textAfterCursor
      } else if (item.id === 'diff-staged') {
        newText = textBeforeCursor.replace(/@git(?::\w*)?\s?[^\s]*$/, '@git:diff:staged ') + textAfterCursor
      } else if (item.id === 'commit') {
        newText = textBeforeCursor.replace(/@git(?::\w*)?\s?[^\s]*$/, '@git:commit ') + textAfterCursor
        setGitMode('commit')
        setShowGitSuggestions(true)
        setValue(newText)
        setTimeout(() => {
          textarea.focus()
          const newCursorPos = newText.length - textAfterCursor.length
          textarea.setSelectionRange(newCursorPos, newCursorPos)
        }, 0)
        return
      } else {
        newText = textBeforeCursor.replace(/@git(?::\w*)?\s?[^\s]*$/, `@git:${item.id} `) + textAfterCursor
      }
    } else if (item.type === 'commit' && item.commit) {
      newText = textBeforeCursor.replace(/@git(?::commit)?\s?[^\s]*$/, `@git:commit:${item.commit.shortHash} `) + textAfterCursor
    }

    setValue(newText)
    setShowGitSuggestions(false)

    setTimeout(() => {
      textarea.focus()
      textarea.setSelectionRange(newText.length - textAfterCursor.length, newText.length - textAfterCursor.length)
    }, 0)
  }, [value])

  // 键盘事件处理
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // 如果建议框打开，选择建议
      if (showWorkspaceSuggestions) {
        e.preventDefault()
        if (filteredWorkspaces.length > 0) {
          selectWorkspace(filteredWorkspaces[selectedWorkspaceIndex])
        }
        return
      }

      if (showFileSuggestions) {
        e.preventDefault()
        if (fileMatches.length > 0) {
          selectFile(fileMatches[selectedFileIndex])
        }
        return
      }

      if (showGitSuggestions) {
        e.preventDefault()
        if (gitSuggestions.length > 0) {
          selectGitSuggestion(gitSuggestions[selectedGitIndex])
        }
        return
      }

      // 正常发送
      e.preventDefault()
      handleSend()
      return
    }

    // 上下箭头选择建议
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && suggestionMode) {
      e.preventDefault()

      let items: unknown[] = []
      let setState: (fn: (prev: number) => number) => void

      if (showWorkspaceSuggestions) {
        items = filteredWorkspaces
        setState = setSelectedWorkspaceIndex
      } else if (showFileSuggestions) {
        items = fileMatches
        setState = setSelectedFileIndex
      } else {
        items = gitSuggestions
        setState = setSelectedGitIndex
      }

      if (items.length === 0) return

      const maxIndex = items.length - 1
      const direction = e.key === 'ArrowUp' ? -1 : 1

      setState(prev => {
        const newIndex = prev + direction
        if (newIndex < 0) return maxIndex
        if (newIndex > maxIndex) return 0
        return newIndex
      })
      return
    }

    // ESC 关闭建议
    if (e.key === 'Escape') {
      setShowWorkspaceSuggestions(false)
      setShowFileSuggestions(false)
      setShowGitSuggestions(false)
      clearResults()
      return
    }

    // Tab 选择建议
    if (e.key === 'Tab' && !e.shiftKey && suggestionMode) {
      e.preventDefault()

      if (showWorkspaceSuggestions && filteredWorkspaces.length > 0) {
        selectWorkspace(filteredWorkspaces[selectedWorkspaceIndex])
      } else if (showFileSuggestions && fileMatches.length > 0) {
        selectFile(fileMatches[selectedFileIndex])
      } else if (showGitSuggestions && gitSuggestions.length > 0) {
        selectGitSuggestion(gitSuggestions[selectedGitIndex])
      }
    }
  }, [
    showWorkspaceSuggestions,
    showFileSuggestions,
    showGitSuggestions,
    suggestionMode,
    filteredWorkspaces,
    fileMatches,
    gitSuggestions,
    selectedWorkspaceIndex,
    selectedFileIndex,
    selectedGitIndex,
    selectWorkspace,
    selectFile,
    selectGitSuggestion,
    clearResults
  ])

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if ((disabled || isStreaming) && attachments.length === 0) return
    if (!trimmed && attachments.length === 0) return

    onSend(trimmed, undefined, attachments.length > 0 ? attachments : undefined)
    resetInput()
  }, [value, disabled, isStreaming, attachments, onSend])

  const resetInput = useCallback(() => {
    setValue('')
    setAttachments([])
    setShowWorkspaceSuggestions(false)
    setShowFileSuggestions(false)
    setShowGitSuggestions(false)
    clearResults()
  }, [clearResults])

  const handleTranslateAndSend = useCallback(async () => {
    const trimmed = value.trim()
    if (!trimmed || disabled || isStreaming || isTranslating) return

    const baiduConfig = config?.baiduTranslate
    if (!baiduConfig?.appId || !baiduConfig?.secretKey) {
      alert(t('error.apiKeyNotSet'))
      return
    }

    setIsTranslating(true)
    try {
      const result = await baiduTranslate(trimmed, baiduConfig.appId, baiduConfig.secretKey)
      if (result.success && result.result) {
        onSend(result.result, undefined, attachments.length > 0 ? attachments : undefined)
        resetInput()
      } else {
        alert(t('error.translateFailed') + ': ' + (result.error || 'Unknown error'))
      }
    } catch (e) {
      alert(t('error.translateFailed') + ': ' + (e instanceof Error ? e.message : 'Unknown error'))
    } finally {
      setIsTranslating(false)
    }
  }, [value, disabled, isStreaming, isTranslating, config, attachments, onSend, resetInput, t])

  // 点击外部关闭建议
  useEffect(() => {
    const handleClickOutside = () => {
      setShowWorkspaceSuggestions(false)
      setShowFileSuggestions(false)
      setShowGitSuggestions(false)
    }

    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [])

  const canSend = (value.trim() || attachments.length > 0) && !disabled && !isStreaming
  const hasReadyAttachments = attachments.some(a => a.status === 'ready')

  return (
    <div className="border-t border-border bg-background-elevated" ref={containerRef}>
      <div className="p-3">
        {/* 附件预览 */}
        <AttachmentPreview
          attachments={attachments}
          onRemove={removeAttachment}
        />

        {/* 输入框容器 */}
        <div
          className="relative flex items-end gap-2 bg-background-surface border border-border rounded-xl p-2 focus-within:ring-2 focus-within:ring-border focus-within:border-primary transition-all shadow-soft hover:shadow-medium"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          {/* 隐藏的文件输入 */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            accept="image/*,.ts,.tsx,.js,.jsx,.json,.md,.txt,.py,.go,.rs,.java,.c,.cpp,.h"
          />

          {/* 附件按钮 */}
          <button
            onClick={openFileDialog}
            disabled={disabled || isStreaming}
            className="shrink-0 p-1.5 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors disabled:opacity-50"
            title="添加附件 (支持图片、文件)"
          >
            <IconPaperclip size={18} />
          </button>

          {/* 文本输入 */}
          <AutoResizingTextarea
            ref={textareaRef}
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={attachments.length > 0 ? '描述你的问题或直接发送...' : t('input.placeholder')}
            className="flex-1 px-2 py-1.5 bg-transparent text-text-primary placeholder:text-text-tertiary resize-none outline-none text-sm leading-relaxed"
            disabled={disabled}
            maxHeight={180}
            minHeight={36}
          />

          {/* 发送/中断按钮 */}
          {isStreaming && onInterrupt ? (
            <Button
              variant="danger"
              size="sm"
              onClick={onInterrupt}
              className="shrink-0 h-8 px-3 text-xs"
            >
              <IconStop size={12} className="mr-1" />
              {t('input.interrupt')}
            </Button>
          ) : (
            <>
              {config?.baiduTranslate?.appId && config?.baiduTranslate?.secretKey && value.trim() && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleTranslateAndSend}
                  disabled={disabled || isStreaming || isTranslating}
                  className="shrink-0 h-8 px-3 text-xs"
                >
                  {isTranslating ? t('input.translating') : t('input.translateAndSend')}
                </Button>
              )}
              <Button
                onClick={handleSend}
                disabled={!canSend}
                size="sm"
                className="shrink-0 h-8 px-3 text-xs shadow-glow"
              >
                <IconSend size={12} className="mr-1" />
                {t('input.send')}
              </Button>
            </>
          )}
        </div>

        {/* 状态栏 */}
        <div className="flex items-center justify-between mt-1.5 px-1">
          <div className="flex items-center gap-2 text-xs text-text-tertiary">
            {hasPendingQuestion ? (
              <span className="flex items-center gap-1 text-accent">
                <span className="w-1 h-1 bg-accent rounded-full animate-pulse" />
                {t('question.pendingAnswer')}
              </span>
            ) : isStreaming ? (
              <span className="flex items-center gap-2">
                <span className="w-1 h-1 bg-warning rounded-full animate-pulse" />
                {t('status.generating')}
              </span>
            ) : suggestionMode === 'workspace' ? (
              <span>{t('input.selectWorkspace')}</span>
            ) : suggestionMode === 'file' ? (
              <span>{t('input.selectFile')}</span>
            ) : suggestionMode === 'git' ? (
              <span>{t('input.gitContext')}</span>
            ) : attachments.length > 0 ? (
              <span className="flex items-center gap-1">
                <IconPaperclip size={10} />
                {attachments.length} 个附件
                {hasReadyAttachments && ' · 可直接发送'}
              </span>
            ) : value.length === 0 ? (
              <span>{t('input.hint')}</span>
            ) : null}
          </div>
          {value.length > 0 && (
            <div className="text-xs text-text-tertiary">
              {value.length}
            </div>
          )}
        </div>
      </div>

      {/* 工作区建议 */}
      {showWorkspaceSuggestions && filteredWorkspaces.length > 0 && (
        <WorkspaceSuggestion
          workspaces={filteredWorkspaces}
          currentWorkspaceId={currentWorkspaceId}
          selectedIndex={selectedWorkspaceIndex}
          onSelect={selectWorkspace}
          onHover={setSelectedWorkspaceIndex}
          position={workspacePosition}
        />
      )}

      {/* 文件建议 */}
      {showFileSuggestions && fileMatches.length > 0 && (
        <FileSuggestion
          files={fileMatches}
          selectedIndex={selectedFileIndex}
          onSelect={selectFile}
          onHover={setSelectedFileIndex}
          position={filePosition}
        />
      )}

      {/* Git 建议 */}
      {showGitSuggestions && (
        <GitSuggestion
          mode={gitMode}
          items={gitSuggestions}
          selectedIndex={selectedGitIndex}
          query={gitQuery}
          onSelect={selectGitSuggestion}
          onHover={setSelectedGitIndex}
          position={gitPosition}
          isLoading={isGitLoading}
        />
      )}
    </div>
  )
}
