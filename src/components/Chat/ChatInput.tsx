/**
 * 聊天输入组件 - 支持附件和工作区文件引用
 *
 * 支持功能:
 * - 文本输入
 * - 文件/图片附件 (粘贴、拖放、选择)
 * - 工作区引用 (@workspace)
 * - 文件引用 (@/path)
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { IconSend, IconStop, IconPaperclip } from '../Common/Icons'
import { useWorkspaceStore, useChatInputStore, useEventChatStore } from '../../stores'
import { useActiveSessionId } from '../../stores/conversationStore'
import { useActiveSessionInputDraft, useActiveSessionActions, useActiveSessionWorkspace } from '../../stores/conversationStore/useActiveSession'
import { useDebouncedCallback } from '../../hooks/useDebounce'
import { UnifiedSuggestion, type SuggestionItem } from './FileSuggestion'
import { AttachmentPreview } from './AttachmentPreview'
import { AutoResizingTextarea } from './AutoResizingTextarea'
import { useFileSearch } from '../../hooks/useFileSearch'
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

export function ChatInput({
  onSend,
  disabled = false,
  isStreaming = false,
  onInterrupt,
  currentWorkDir: _currentWorkDir,
}: ChatInputProps) {
  const { t } = useTranslation('chat')

  // 当前会话 ID（用于检测会话切换）
  const sessionId = useActiveSessionId()

  // 获取当前会话的工作区
  const currentWorkspace = useActiveSessionWorkspace()

  // 使用 Store 中的输入草稿（用于会话切换同步）
  const inputDraft = useActiveSessionInputDraft()
  const { updateInputDraft, clearInputDraft } = useActiveSessionActions()

  // 本地 state（即时响应）
  const [localText, setLocalText] = useState('')
  const [localAttachments, setLocalAttachments] = useState<Attachment[]>([])

  // 创建防抖的持久化函数（300ms 延迟）
  const { debounced: debouncedPersistDraft, cancel: cancelPersistDraft } = useDebouncedCallback(
    (text: string, attachments: Attachment[]) => {
      updateInputDraft({ text, attachments })
    },
    300
  )

  // 会话切换时同步 Store 草稿到本地 state（只在 sessionId 变化时执行）
  useEffect(() => {
    setLocalText(inputDraft.text)
    setLocalAttachments(inputDraft.attachments)
  }, [sessionId])  // 依赖 sessionId 而非 inputDraft

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 从本地 state 获取当前值
  const value = localText
  const attachments = localAttachments

  // 统一建议状态
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestionItems, setSuggestionItems] = useState<SuggestionItem[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [suggestionPosition, setSuggestionPosition] = useState({ top: 0, left: 0 })
  const [fileWorkspace, setFileWorkspace] = useState<Workspace | null>(null)

  const { currentWorkspaceId, workspaces } = useWorkspaceStore()
  const { fileMatches, searchFiles, clearResults } = useFileSearch()
  const {
    setInputLength,
    setAttachmentCount,
    setSuggestionMode,
    setHasPendingQuestion,
    setHasActivePlan,
    speechTranscript,
    speechCommand,
    clearSpeechTranscript,
    setSpeechCommand,
  } = useChatInputStore()

  // 处理语音识别文字
  useEffect(() => {
    if (speechTranscript) {
      const newText = localText + speechTranscript
      // 立即更新本地 state
      setLocalText(newText)
      // 持久化到 Store（立即，不防抖，因为是一次性追加）
      updateInputDraft({ text: newText, attachments })
      clearSpeechTranscript()
      textareaRef.current?.focus()
    }
  }, [speechTranscript, clearSpeechTranscript, localText, attachments, updateInputDraft])

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

  // 检查是否有活跃的计划（等待审批）
  const hasActivePlan = useEventChatStore(state => {
    if (!state.activePlanId || !state.currentMessage) return false
    const planBlockIndex = state.planBlockMap.get(state.activePlanId)
    if (planBlockIndex === undefined) return false
    const block = state.currentMessage.blocks[planBlockIndex]
    if (block?.type === 'plan_mode') {
      return block.status === 'pending_approval' || block.status === 'drafting'
    }
    return false
  })

  // 同步状态到 store
  useEffect(() => {
    setHasPendingQuestion(hasPendingQuestion)
  }, [hasPendingQuestion, setHasPendingQuestion])

  useEffect(() => {
    setHasActivePlan(hasActivePlan)
  }, [hasActivePlan, setHasActivePlan])

  // 同步字数到 store
  useEffect(() => {
    setInputLength(value.length)
  }, [value.length, setInputLength])

  // 同步附件数量到 store
  useEffect(() => {
    setAttachmentCount(attachments.length)
  }, [attachments.length, setAttachmentCount])

  // 同步建议模式到 store
  useEffect(() => {
    setSuggestionMode(showSuggestions ? 'file' : null)
  }, [showSuggestions, setSuggestionMode])

  // 智能定位建议框
  const calculateSuggestionPosition = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return { top: 0, left: 0 }

    const rect = textarea.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const suggestionHeight = 320
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
    const newAttachments = [...attachments, attachment]
    const totalValidation = validateAttachments(newAttachments)
    if (!totalValidation.valid) {
      console.warn('[ChatInput] 总附件验证失败:', totalValidation.error)
      return
    }
    // 立即更新本地 state
    setLocalAttachments(newAttachments)
    // 持久化到 Store
    debouncedPersistDraft(value, newAttachments)
  }, [attachments, value, debouncedPersistDraft])

  // 移除附件
  const removeAttachment = useCallback((id: string) => {
    const newAttachments = attachments.filter(a => a.id !== id)
    // 立即更新本地 state
    setLocalAttachments(newAttachments)
    // 持久化到 Store
    debouncedPersistDraft(value, newAttachments)
  }, [attachments, value, debouncedPersistDraft])

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

  // 构建统一建议列表
  const buildSuggestionItems = useCallback((
    workspaceList: Workspace[],
    fileList: FileMatch[],
    filterQuery?: string
  ): SuggestionItem[] => {
    const items: SuggestionItem[] = []

    // 添加工作区
    const filteredWorkspaces = filterQuery
      ? workspaceList.filter(w => w.name.toLowerCase().includes(filterQuery.toLowerCase()))
      : workspaceList
    filteredWorkspaces.forEach(w => {
      items.push({ type: 'workspace', data: w })
    })

    // 添加文件
    fileList.forEach(f => {
      items.push({ type: 'file', data: f })
    })

    return items
  }, [])

  // 检测触发符
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    // 立即更新本地 state（即时响应）
    setLocalText(newValue)
    // 防抖持久化到 Store
    debouncedPersistDraft(newValue, attachments)

    const textarea = textareaRef.current
    if (!textarea || !containerRef.current) return

    const cursorPosition = textarea.selectionStart
    const textBeforeCursor = newValue.slice(0, cursorPosition)

    // 1. 检测跨工作区引用 (@/path)
    const crossWorkspaceMatch = textBeforeCursor.match(/@\/([^\s]*)$/)
    if (crossWorkspaceMatch) {
      const pathPart = crossWorkspaceMatch[1] || ''
      const items = buildSuggestionItems(workspaces, [], pathPart)
      setSuggestionItems(items)
      setSelectedIndex(0)
      setShowSuggestions(items.length > 0)
      setFileWorkspace(null)

      const position = calculateSuggestionPosition()
      setSuggestionPosition({ top: position.top, left: position.left })
      return
    }

    // 2. 检测 @workspace:path 语法（已指定工作区）
    const workspaceMatch = textBeforeCursor.match(/@([\w\u4e00-\u9fa5-]+):([^\s]*)$/)
    if (workspaceMatch) {
      const workspaceName = workspaceMatch[1]
      const pathPart = workspaceMatch[2] || ''

      const matchedWorkspace = workspaces.find(w =>
        w.name.toLowerCase() === workspaceName.toLowerCase()
      )

      if (matchedWorkspace) {
        // 找到匹配的工作区，显示该工作区的文件
        setFileWorkspace(matchedWorkspace)
        searchFiles(pathPart, matchedWorkspace)
      } else {
        // 未找到工作区，显示工作区列表
        const items = buildSuggestionItems(workspaces, [], workspaceName)
        setSuggestionItems(items)
        setSelectedIndex(0)
        setShowSuggestions(items.length > 0)
        setFileWorkspace(null)
      }

      const position = calculateSuggestionPosition()
      setSuggestionPosition({ top: position.top, left: position.left })
      return
    }

    // 3. 检测用户正在输入工作区名或文件路径（无冒号）
    const partialMatch = textBeforeCursor.match(/@([\w\u4e00-\u9fa5-\u4e00-\u9fa5/.\\_-]*)$/)
    if (partialMatch) {
      const query = partialMatch[1]

      // 如果包含路径分隔符，说明是在输入当前工作区的文件路径
      if (query.includes('/') || query.includes('\\') || query.includes('.')) {
        setShowSuggestions(false)
        setSuggestionItems([])
        setFileWorkspace(null)
        searchFiles(query)

        const position = calculateSuggestionPosition()
        setSuggestionPosition({ top: position.top, left: position.left })
        return
      }

      // 同时显示工作区和当前工作区文件建议
      if (query.length > 0) {
        const items = buildSuggestionItems(workspaces, [], query)
        setSuggestionItems(items)
        setSelectedIndex(0)
        // 始终显示建议浮窗，因为文件搜索可能返回结果
        setShowSuggestions(true)
        setFileWorkspace(null)
        // 同时搜索当前工作区文件
        searchFiles(query)

        const position = calculateSuggestionPosition()
        setSuggestionPosition({ top: position.top, left: position.left })
        return
      }
    }

    // 4. 检测单独的 @ 符号（显示工作区列表和当前工作区文件提示）
    const atOnlyMatch = textBeforeCursor.match(/@$/)
    if (atOnlyMatch) {
      const items = buildSuggestionItems(workspaces, [])
      setSuggestionItems(items)
      setSelectedIndex(0)
      setShowSuggestions(items.length > 0)
      setFileWorkspace(null)
      // 搜索当前工作区文件（空查询显示所有）
      searchFiles('')

      const position = calculateSuggestionPosition()
      setSuggestionPosition({ top: position.top, left: position.left })
      return
    }

    // 隐藏所有建议
    setShowSuggestions(false)
    setSuggestionItems([])
    clearResults()
  }, [workspaces, searchFiles, clearResults, calculateSuggestionPosition, buildSuggestionItems, attachments, debouncedPersistDraft])

  // 当 fileMatches 更新时，合并到 suggestionItems
  useEffect(() => {
    // 重新构建建议列表，包含工作区和文件
    const workspaceItems = suggestionItems.filter(i => i.type === 'workspace')
    const fileItems: SuggestionItem[] = fileMatches.map(f => ({ type: 'file' as const, data: f }))
    const newItems = [...workspaceItems, ...fileItems]

    if (newItems.length > 0) {
      setSuggestionItems(newItems)
      // 如果有结果但当前未显示，则显示建议浮窗
      if (!showSuggestions) {
        setShowSuggestions(true)
        setSelectedIndex(0)
      }
    }
  }, [fileMatches])

  // 选择建议项
  const selectSuggestion = useCallback((item: SuggestionItem) => {
    const textarea = textareaRef.current
    if (!textarea) return

    const cursorPosition = textarea.selectionStart
    const textBeforeCursor = value.slice(0, cursorPosition)
    const textAfterCursor = value.slice(cursorPosition)

    let newText: string

    if (item.type === 'workspace') {
      const workspace = item.data as Workspace
      newText = textBeforeCursor.replace(/@[\w\u4e00-\u9fa5-/]*$/, `@${workspace.name}:`) + textAfterCursor
    } else {
      const file = item.data as FileMatch
      if (fileWorkspace) {
        // 跨工作区引用: @workspace:path
        newText = textBeforeCursor.replace(/@[\w\u4e00-\u9fa5-]+:[^\s]*$/, `@${fileWorkspace.name}:${file.relativePath} `) + textAfterCursor
      } else {
        // 当前工作区引用: @path
        newText = textBeforeCursor.replace(/@[^\s]*$/, `@${file.relativePath} `) + textAfterCursor
      }
    }

    // 立即更新本地 state
    setLocalText(newText)
    // 持久化到 Store
    debouncedPersistDraft(newText, attachments)
    setShowSuggestions(false)
    setSuggestionItems([])
    setFileWorkspace(null)

    setTimeout(() => {
      textarea.focus()
      const newCursorPos = newText.length - textAfterCursor.length
      textarea.setSelectionRange(newCursorPos, newCursorPos)
    }, 0)
  }, [value, fileWorkspace, attachments, debouncedPersistDraft])

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if ((disabled || isStreaming) && attachments.length === 0) return
    if (!trimmed && attachments.length === 0) return

    // 取消 pending 的防抖回调，防止旧值写回 Store
    cancelPersistDraft()
    // 传递当前会话的工作区路径
    onSend(trimmed, currentWorkspace?.path, attachments.length > 0 ? attachments : undefined)
    // 清空本地 state
    setLocalText('')
    setLocalAttachments([])
    // 清空 Store 草稿
    updateInputDraft({ text: '', attachments: [] })
  }, [value, disabled, isStreaming, attachments, onSend, updateInputDraft, cancelPersistDraft, currentWorkspace])

  // 处理语音命令（放在 handleSend 之后，避免变量声明顺序问题）
  useEffect(() => {
    if (!speechCommand) return

    switch (speechCommand) {
      case 'send':
        if (!isStreaming) {
          handleSend()
        }
        break
      case 'clear':
        // 清除本地 state
        setLocalText('')
        setLocalAttachments([])
        // 清除 Store
        clearInputDraft()
        break
      // 'interrupt' 已在 ChatStatusBar 处理
    }

    setSpeechCommand(null)
  }, [speechCommand, isStreaming, setSpeechCommand, clearInputDraft, handleSend])

  // 键盘事件处理
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // 如果建议框打开，选择建议
      if (showSuggestions && suggestionItems.length > 0) {
        e.preventDefault()
        selectSuggestion(suggestionItems[selectedIndex])
        return
      }

      // 正常发送
      e.preventDefault()
      handleSend()
      return
    }

    // 上下箭头选择建议
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && showSuggestions && suggestionItems.length > 0) {
      e.preventDefault()

      const maxIndex = suggestionItems.length - 1
      const direction = e.key === 'ArrowUp' ? -1 : 1

      setSelectedIndex(prev => {
        const newIndex = prev + direction
        if (newIndex < 0) return maxIndex
        if (newIndex > maxIndex) return 0
        return newIndex
      })
      return
    }

    // ESC 关闭建议
    if (e.key === 'Escape') {
      setShowSuggestions(false)
      setSuggestionItems([])
      clearResults()
      return
    }

    // Tab 选择建议
    if (e.key === 'Tab' && !e.shiftKey && showSuggestions && suggestionItems.length > 0) {
      e.preventDefault()
      selectSuggestion(suggestionItems[selectedIndex])
    }
  }, [
    showSuggestions,
    suggestionItems,
    selectedIndex,
    selectSuggestion,
    clearResults,
    handleSend,
  ])

  // 点击外部关闭建议
  useEffect(() => {
    const handleClickOutside = () => {
      setShowSuggestions(false)
      setSuggestionItems([])
    }

    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [])

  const canSend = (value.trim() || attachments.length > 0) && !disabled && !isStreaming

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

          {/* 文本输入 */}
          <AutoResizingTextarea
            ref={textareaRef}
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={attachments.length > 0 ? t('input.placeholderWithAttachment') : t('input.placeholder')}
            className="flex-1 px-2 py-1.5 bg-transparent text-text-primary placeholder:text-text-tertiary resize-none outline-none text-sm leading-relaxed"
            disabled={disabled}
            maxHeight={180}
            minHeight={36}
          />

          {/* 右侧按钮组 - 垂直布局 */}
          <div className="flex flex-col gap-1 shrink-0">
            {/* 附件按钮 */}
            <button
              onClick={openFileDialog}
              disabled={disabled || isStreaming}
              className="shrink-0 p-1.5 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors disabled:opacity-50"
              title={t('input.addAttachment')}
            >
              <IconPaperclip size={18} />
            </button>

            {/* 发送/中断按钮 */}
            {isStreaming && onInterrupt ? (
              <button
                onClick={onInterrupt}
                className="shrink-0 p-1.5 rounded-lg bg-danger text-white hover:bg-danger-hover transition-colors"
                title={t('input.interrupt')}
              >
                <IconStop size={18} />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!canSend}
                className="shrink-0 p-1.5 rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title={t('input.send')}
              >
                <IconSend size={18} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 统一建议浮窗 */}
      {showSuggestions && suggestionItems.length > 0 && (
        <UnifiedSuggestion
          items={suggestionItems}
          selectedIndex={selectedIndex}
          onSelect={selectSuggestion}
          onHover={setSelectedIndex}
          position={suggestionPosition}
          currentWorkspaceId={currentWorkspaceId}
        />
      )}
    </div>
  )
}
