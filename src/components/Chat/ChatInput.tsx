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
import { Sparkles } from 'lucide-react'
import { useWorkspaceStore, useSessionStore, useToastStore } from '@/stores'
import { voiceNotificationService } from '@/services/voiceNotificationService'
import { useActiveSessionInputDraft, useActiveSessionActions, useActiveSessionWorkspace, useActiveSessionPromptSuggestion } from '@/stores/conversationStore/useActiveSession'
import { useDebouncedCallback } from '@/hooks/useDebounce'
import { UnifiedSuggestion, type SuggestionItem, type ConversationSuggestion } from './FileSuggestion'
import { AttachmentPreview } from './AttachmentPreview'
import { AutoResizingTextarea } from './AutoResizingTextarea'
import { SnippetParamPanel } from './SnippetParamPanel'
import { useFileSearch } from '@/hooks/useFileSearch'
import { useSnippetStore } from '@/stores/snippetStore'
import { resolveTemplateVariables } from '@/services/workspaceReference'
import type { FileMatch } from '@/services/fileSearch'
import type { Workspace } from '@/types'
import type { Attachment } from '@/types/attachment'
import { createLogger } from '@/utils/logger'
import { normalizeEngineId } from '@/utils/engineDisplay'
import { dialogStorageService } from '@/services/dialogStorage/service'
import { packForReference } from '@/services/conversationPackager'
import type { PromptSnippet } from '@/types/promptSnippet'
import {
  createAttachment,
  validateAttachment,
  validateAttachments,
  isImageType,
  ATTACHMENT_LIMITS,
} from '@/types/attachment'

const log = createLogger('ChatInput')

export interface EditMode {
  messageId: string
  content: string
}

interface ChatInputProps {
  onSend: (message: string, workspaceDir?: string, attachments?: Attachment[]) => void
  disabled?: boolean
  isStreaming?: boolean
  onInterrupt?: () => void
  currentWorkDir?: string | null
  editMode?: EditMode | null
  onCancelEdit?: () => void
  onEditSend?: (messageId: string, newContent: string, workspaceDir?: string) => void
  /**
   * 嵌入式状态栏（会话配置选择器/语音区等）。
   * 渲染在底部工具栏中段（附件按钮和发送按钮之间）。
   * 不传则只显示附件 + 发送（用于 AIPopover 等极简场景）。
   */
  statusBarSlot?: React.ReactNode
}

export function ChatInput({
  onSend,
  disabled = false,
  isStreaming = false,
  onInterrupt,
  currentWorkDir: _currentWorkDir,
  editMode = null,
  onCancelEdit,
  onEditSend,
  statusBarSlot,
}: ChatInputProps) {
  const { t } = useTranslation('chat')

  // 获取当前会话的工作区
  const currentWorkspace = useActiveSessionWorkspace()

  // 使用 Store 中的输入草稿（用于会话切换同步）
  const inputDraft = useActiveSessionInputDraft()
  const promptSuggestion = useActiveSessionPromptSuggestion()
  const { updateInputDraft, clearInputDraft, setPromptSuggestion } = useActiveSessionActions()

  // 本地 state（即时响应）
  const [localText, setLocalText] = useState('')
  const [localAttachments, setLocalAttachments] = useState<Attachment[]>([])
  const [activeSnippet, setActiveSnippet] = useState<PromptSnippet | null>(null)

  // Prompt 历史记录（终端风格 ArrowUp 召回）
  const sentHistoryRef = useRef<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const savedCurrentInputRef = useRef('')

  // 编辑模式同步：进入编辑模式时填入消息内容
  useEffect(() => {
    if (editMode) {
      setLocalText(editMode.content)
      setHistoryIndex(-1)
      // 聚焦输入框
      setTimeout(() => textareaRef.current?.focus(), 0)
    }
  }, [editMode])

  // 创建防抖的持久化函数（300ms 延迟）
  const { debounced: debouncedPersistDraft, cancel: cancelPersistDraft } = useDebouncedCallback(
    (text: string, attachments: Attachment[]) => {
      updateInputDraft({ text, attachments })
    },
    300
  )

  // 会话切换时同步 Store 草稿到本地 state（只在 sessionId 变化时执行）
  // inputDraft 在 sessionId 变化时才会更新，无需添加依赖
  useEffect(() => {
    setLocalText(inputDraft.text)
    setLocalAttachments(inputDraft.attachments)
  }, [inputDraft])

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 监听全局聚焦请求（快捷键新建会话等场景触发，见 useWindowManager）
  useEffect(() => {
    const handleFocusRequest = () => {
      // 推迟一拍，确保会话切换引起的重渲染完成后再聚焦
      setTimeout(() => textareaRef.current?.focus(), 0)
    }
    window.addEventListener('chat:focus-input', handleFocusRequest)
    return () => window.removeEventListener('chat:focus-input', handleFocusRequest)
  }, [])

  // 从本地 state 获取当前值
  const value = localText
  const attachments = localAttachments

  // 统一建议状态
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestionItems, setSuggestionItems] = useState<SuggestionItem[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [suggestionPosition, setSuggestionPosition] = useState({ top: 0, left: 0 })
  const [fileWorkspace, setFileWorkspace] = useState<Workspace | null>(null)
  // @对话 引用：历史会话建议
  const [conversationMatches, setConversationMatches] = useState<ConversationSuggestion[]>([])
  const [conversationMode, setConversationMode] = useState(false)

  const { currentWorkspaceId, workspaces } = useWorkspaceStore()
  const { fileMatches, searchFiles, clearResults } = useFileSearch()

  // 加载历史会话列表（全引擎聚合：saveDialog 对所有引擎统一落盘）供 @对话 引用
  const searchConversations = useCallback(async (query: string) => {
    try {
      const result = await dialogStorageService.listConversations({ pageSize: 50 })
      const q = query.toLowerCase().trim()
      const items: ConversationSuggestion[] = result.items
        .filter(m => !q
          || (m.title ?? '').toLowerCase().includes(q)
          || (m.firstUserText ?? '').toLowerCase().includes(q))
        .map(m => ({
          externalId: m.externalId,
          title: m.title || '(无标题)',
          engineId: normalizeEngineId(m.engineId),
          messageCount: m.messageCount,
          updatedAt: m.updatedAt,
          // 源对话工作区：落盘优先用它，避免当前会话无工作区时无法导出
          workspacePath: m.workspacePath ?? null,
        }))
      setConversationMatches(items)
    } catch (e) {
      log.warn('加载历史对话列表失败', { error: String(e) })
      setConversationMatches([])
    }
  }, [])
  const {
    setInputLength,
    setAttachmentCount,
    setSuggestionMode,
    speechTranscript,
    speechCommand,
    clearSpeechTranscript,
    setSpeechCommand,
    setSpeechWakeActive,
    setInputWasVoice,
  } = useSessionStore()

  // 处理语音识别文字
  useEffect(() => {
    if (speechTranscript) {
      const newText = localText + speechTranscript
      // 立即更新本地 state
      setLocalText(newText)
      // 持久化到 Store（立即，不防抖，因为是一次性追加）
      updateInputDraft({ text: newText, attachments })
      // 标记输入来源为语音
      setInputWasVoice(true)
      clearSpeechTranscript()
      textareaRef.current?.focus()
    }
  }, [speechTranscript, clearSpeechTranscript, localText, attachments, updateInputDraft, setInputWasVoice])

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

    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 300))

    return {
      top: shouldShowAbove ? rect.top - suggestionHeight - 8 : rect.bottom + 8,
      left,
    }
  }, [])

  // 添加附件
  const addAttachment = useCallback(async (file: File, source: 'paste' | 'drag' | 'select') => {
    // 验证
    const validation = validateAttachment(file)
    if (!validation.valid) {
      log.warn('Attachment validation failed', { error: validation.error })
      useToastStore.getState().error(validation.error!)
      return
    }

    // 创建附件
    const attachment = await createAttachment(file, source)
    const newAttachments = [...attachments, attachment]
    const totalValidation = validateAttachments(newAttachments)
    if (!totalValidation.valid) {
      log.warn('Total attachment validation failed', { error: totalValidation.error })
      useToastStore.getState().error(totalValidation.error!)
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
    // 用户手动编辑时退出历史浏览模式
    if (historyIndex >= 0) setHistoryIndex(-1)
    // 防抖持久化到 Store
    debouncedPersistDraft(newValue, attachments)

    // 非 @对话 分支默认退出历史对话模式（@对话 分支内会重新置 true）
    setConversationMode(false)

    const textarea = textareaRef.current
    if (!textarea || !containerRef.current) return

    const cursorPosition = textarea.selectionStart
    const textBeforeCursor = newValue.slice(0, cursorPosition)

    // === 0. 片段触发检测（行首 / ，必须在所有 @ 检测之前） ===
    // 仅在整个输入内容以 / 开头时触发（排除 @/path 中的 /）
    if (newValue.startsWith('/') && !newValue.includes('@')) {
      const query = newValue.slice(1).toLowerCase()
      const snippets = useSnippetStore.getState().snippets
      const matched: SuggestionItem[] = snippets
        .filter(s => s.enabled && s.name.toLowerCase().startsWith(query))
        .map(s => ({ type: 'snippet' as const, data: s }))

      if (matched.length > 0) {
        setSuggestionItems(matched)
        setSelectedIndex(0)
        setShowSuggestions(true)
        const position = calculateSuggestionPosition()
        setSuggestionPosition({ top: position.top, left: position.left })
        return // 不继续走 @ 检测
      }
    }

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

    // 1.5 检测 @对话 引用（历史会话 → packToSummary 落盘 → 转 @path 注入）
    //     必须在 partialMatch（会匹配中文「对话」）之前拦截
    const conversationMatch = textBeforeCursor.match(/@对话(?:\s+(\S*))?$/)
    if (conversationMatch) {
      setConversationMode(true)
      setFileWorkspace(null)
      setSuggestionItems([])
      setShowSuggestions(true)
      setSelectedIndex(0)
      void searchConversations(conversationMatch[1] ?? '')

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
  }, [workspaces, searchFiles, clearResults, calculateSuggestionPosition, buildSuggestionItems, attachments, debouncedPersistDraft, historyIndex, searchConversations])

  // 当 fileMatches 更新时，合并到 suggestionItems（@对话 模式下不合并文件）
  useEffect(() => {
    if (conversationMode) return
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- showSuggestions/suggestionItems toggles visibility only
  }, [fileMatches])

  // @对话 模式：历史会话列表加载后，合并到 suggestionItems
  useEffect(() => {
    if (!conversationMode) return
    const items: SuggestionItem[] = conversationMatches.map(c => ({ type: 'conversation' as const, data: c }))
    setSuggestionItems(items)
    setShowSuggestions(items.length > 0)
    setSelectedIndex(0)
  }, [conversationMatches, conversationMode])

  // 解析自动变量（提前定义，供 selectSuggestion 使用）
  const resolveSnippetAutoVars = useCallback((content: string): string => {
    return resolveTemplateVariables(content, {
      workspaceName: currentWorkspace?.name ?? '',
      workspacePath: currentWorkspace?.path ?? '',
      contextWorkspaces: [],
    })
  }, [currentWorkspace])

  // 选择建议项
  const selectSuggestion = useCallback((item: SuggestionItem) => {
    const textarea = textareaRef.current
    if (!textarea) return

    const cursorPosition = textarea.selectionStart
    const textBeforeCursor = value.slice(0, cursorPosition)
    const textAfterCursor = value.slice(cursorPosition)

    let newText: string

    if (item.type === 'snippet') {
      // 片段选中：清除 /xxx，弹出变量填写或直接展开
      const snippet = item.data as PromptSnippet
      const expanded = resolveSnippetAutoVars(snippet.content)
      if (snippet.variables.length > 0) {
        // 有用户变量，弹出填写面板
        setActiveSnippet(snippet)
      } else {
        // 无变量，直接展开
        setLocalText(expanded)
        debouncedPersistDraft(expanded, attachments)
      }
      setShowSuggestions(false)
      setSuggestionItems([])
      return
    } else if (item.type === 'conversation') {
      // @对话 引用：加载源消息 → packForReference 落盘 → 把 @对话 替换为 @path（复用现有 @path 注入链）
      const conv = item.data as ConversationSuggestion
      const beforeCursor = textBeforeCursor
      const afterCursor = textAfterCursor
      // 落盘工作区：优先用源对话自己的工作区（它本来就在那产生），
      // 避免当前会话（如无工作区的 mimo 会话）无 path 时报「未关联工作区」。
      // 两者都没有才真正无法导出。
      const workspacePath = conv.workspacePath || currentWorkspace?.path || ''
      setShowSuggestions(false)
      setSuggestionItems([])
      setConversationMode(false)

      void (async () => {
        try {
          if (!workspacePath) {
            useToastStore.getState().error(t('handoff.failToast'), t('handoff.reasonNoWorkspace'))
            return
          }
          const messages = await dialogStorageService.getConversationMessages(conv.externalId)
          if (messages.length === 0) {
            useToastStore.getState().error(t('handoff.failToast'), t('handoff.emptyContent'))
            return
          }
          // 摘要模式：控制注入体积，避免上下文膨胀
          const { fileRef } = await packForReference(messages, conv.title, conv.externalId, workspacePath)
          const replaced = beforeCursor.replace(/@对话(?:\s+\S*)?$/, `@${fileRef.relPath} `) + afterCursor
          setLocalText(replaced)
          debouncedPersistDraft(replaced, attachments)
          log.info('@对话 引用已插入', { externalId: conv.externalId, ref: fileRef.relPath })
          setTimeout(() => {
            textarea.focus()
            const newCursorPos = replaced.length - afterCursor.length
            textarea.setSelectionRange(newCursorPos, newCursorPos)
          }, 0)
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e))
          log.error('@对话 引用插入失败', err, { externalId: conv.externalId })
          useToastStore.getState().error(t('handoff.failToast'), err.message)
        }
      })()
      return
    } else if (item.type === 'workspace') {
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
  }, [value, fileWorkspace, attachments, debouncedPersistDraft, resolveSnippetAutoVars, currentWorkspace, t])

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if ((disabled || isStreaming) && attachments.length === 0) return
    if (!trimmed && attachments.length === 0) return

    // 取消 pending 的防抖回调，防止旧值写回 Store
    cancelPersistDraft()

    // 编辑模式：调用 editAndResend 而非普通发送
    if (editMode && onEditSend) {
      onEditSend(editMode.messageId, trimmed, currentWorkspace?.path)
    } else {
      // 普通发送
      onSend(trimmed, currentWorkspace?.path, attachments.length > 0 ? attachments : undefined)
      // 记录到 prompt 历史（仅普通发送，编辑模式不记录）
      if (trimmed) {
        const history = sentHistoryRef.current
        // 去重：如果最后一条相同则不重复添加
        if (history.length === 0 || history[0] !== trimmed) {
          history.unshift(trimmed)
          if (history.length > 100) history.length = 100
        }
      }
    }

    // 清空本地 state
    setLocalText('')
    setLocalAttachments([])
    // 清空 Store 草稿
    updateInputDraft({ text: '', attachments: [] })
    // 退出编辑模式
    if (editMode) onCancelEdit?.()
    // 重置历史索引
    setHistoryIndex(-1)
    // 发送后重置语音唤醒状态（回到待命）
    setSpeechWakeActive(false)
    // 语音提醒：发送确认
    voiceNotificationService.notifySendConfirm()
  }, [value, disabled, isStreaming, attachments, onSend, updateInputDraft, cancelPersistDraft, currentWorkspace, setSpeechWakeActive, editMode, onEditSend, onCancelEdit])

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

    // 上下箭头选择建议（优先级高于历史记录）
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

    // ArrowUp/ArrowDown prompt 历史记录（终端风格）
    const history = sentHistoryRef.current
    if (e.key === 'ArrowUp' && !showSuggestions && value === '' && history.length > 0) {
      e.preventDefault()
      if (historyIndex === -1) savedCurrentInputRef.current = value
      const newIndex = Math.min(historyIndex + 1, history.length - 1)
      setHistoryIndex(newIndex)
      setLocalText(history[newIndex])
      debouncedPersistDraft(history[newIndex], attachments)
      return
    }
    if (e.key === 'ArrowDown' && !showSuggestions && historyIndex >= 0) {
      e.preventDefault()
      const newIndex = historyIndex - 1
      if (newIndex < 0) {
        setHistoryIndex(-1)
        setLocalText(savedCurrentInputRef.current)
        debouncedPersistDraft(savedCurrentInputRef.current, attachments)
      } else {
        setHistoryIndex(newIndex)
        setLocalText(history[newIndex])
        debouncedPersistDraft(history[newIndex], attachments)
      }
      return
    }

    // ESC 关闭建议 / 中断流式输出 / 退出编辑模式
    if (e.key === 'Escape') {
      if (showSuggestions) {
        setShowSuggestions(false)
        setSuggestionItems([])
        clearResults()
        return
      }
      if (editMode) {
        onCancelEdit?.()
        return
      }
      if (isStreaming && onInterrupt) {
        onInterrupt()
        return
      }
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
    isStreaming,
    onInterrupt,
    value,
    historyIndex,
    attachments,
    debouncedPersistDraft,
    editMode,
    onCancelEdit,
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
    <div className="border-t border-border bg-background-elevated relative" ref={containerRef}>
      {/* 片段变量填写浮窗 */}
      {activeSnippet && (
        <SnippetParamPanel
          snippet={activeSnippet}
          onExpand={(content) => {
            const expanded = resolveSnippetAutoVars(content)
            setLocalText(expanded)
            setActiveSnippet(null)
            debouncedPersistDraft(expanded, attachments)
            setTimeout(() => textareaRef.current?.focus(), 0)
          }}
          onCancel={() => setActiveSnippet(null)}
        />
      )}
      {/* 编辑模式提示条 */}
      {editMode && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/10 border-b border-primary/20 text-xs text-primary">
          <span>{t('input.editingMessage')}</span>
          <button
            onClick={onCancelEdit}
            className="ml-auto px-1.5 py-0.5 rounded hover:bg-primary/20 transition-colors"
          >
            {t('input.cancelEdit')}
          </button>
        </div>
      )}
      {/* 下一步建议气泡（--prompt-suggestions）：仅在输入框为空、非流式、非编辑态时展示 */}
      {promptSuggestion && !value.trim() && !isStreaming && !editMode && (
        <div className="px-2 sm:px-3 pt-2">
          <button
            type="button"
            onClick={() => {
              setLocalText(promptSuggestion)
              setPromptSuggestion(null)
              debouncedPersistDraft(promptSuggestion, attachments)
              setTimeout(() => textareaRef.current?.focus(), 0)
            }}
            title={t('input.promptSuggestionHint')}
            className="group flex items-start gap-1.5 max-w-full px-2.5 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 border border-primary/20 text-xs text-primary/90 text-left transition-colors"
          >
            <Sparkles size={13} className="shrink-0 mt-0.5 opacity-70" />
            <span className="line-clamp-2 break-words">{promptSuggestion}</span>
          </button>
        </div>
      )}
      <div className="p-2 sm:p-3">
        {/* 输入框统一容器（纵向布局：附件预览 + textarea + 底部工具栏） */}
        <div
          className="relative flex flex-col bg-background-surface border border-border rounded-lg sm:rounded-xl focus-within:ring-2 focus-within:ring-border focus-within:border-primary transition-all shadow-soft hover:shadow-medium"
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
            accept={`image/*,${ATTACHMENT_LIMITS.codeExtensions.join(',')}`}
          />

          {/* 附件预览（内嵌到容器顶部） */}
          <AttachmentPreview
            attachments={attachments}
            onRemove={removeAttachment}
          />

          {/* 文本输入（独占整宽，无边框融入外框） */}
          <AutoResizingTextarea
            ref={textareaRef}
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={attachments.length > 0 ? t('input.placeholderWithAttachment') : t('input.placeholder')}
            className="w-full px-2.5 sm:px-3 pt-2 pb-1 bg-transparent text-text-primary placeholder:text-text-tertiary resize-none outline-none text-sm leading-relaxed border-0"
            disabled={disabled}
            maxHeight={200}
            minHeight={40}
          />

          {/* 底部工具栏 - 单行 flex justify-between */}
          <div className="flex items-center gap-1 px-1.5 sm:px-2 pb-1.5 pt-0.5">
            {/* 左侧：附件按钮 */}
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={openFileDialog}
                disabled={disabled || isStreaming}
                className="shrink-0 p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors disabled:opacity-50"
                title={t('input.addAttachment')}
              >
                <IconPaperclip size={16} />
              </button>
            </div>

            {/* 中段：嵌入式状态栏（会话配置/语音区等） */}
            {statusBarSlot && (
              <div className="flex-1 min-w-0 flex items-center">
                {statusBarSlot}
              </div>
            )}
            {/* 无 statusBarSlot 时占位撑开右侧 */}
            {!statusBarSlot && <div className="flex-1" />}

            {/* 右侧：字数 + 发送/中断 */}
            <div className="flex items-center gap-1.5 shrink-0">
              {/* 字数（仅 statusBarSlot 模式下显示） */}
              {statusBarSlot && value.length > 0 && (
                <span className="text-xs text-text-tertiary tabular-nums">{value.length}</span>
              )}
              {/* 发送/中断按钮 */}
              {isStreaming && onInterrupt ? (
                <button
                  onClick={onInterrupt}
                  className="shrink-0 p-1.5 rounded-md bg-danger text-white hover:bg-danger-hover transition-colors"
                  title={t('input.interrupt')}
                >
                  <IconStop size={16} />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!canSend}
                  className="shrink-0 p-1.5 rounded-md bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title={t('input.send')}
                >
                  <IconSend size={16} />
                </button>
              )}
            </div>
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
