/**
 * CompactChatInput - 小屏模式专用输入组件
 *
 * 特点：
 * - 紧凑布局，适合小窗口
 * - 支持 Shift+Enter 换行，Enter 发送
 * - 支持附件
 * - 自动高度调整
 */

import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { IconSend, IconStop, IconPaperclip } from '../Common/Icons'
import { AutoResizingTextarea } from '../Chat/AutoResizingTextarea'
import { AttachmentPreview } from '../Chat/AttachmentPreview'
import {
  createAttachment,
  validateAttachment,
  validateAttachments,
  isImageType,
} from '../../types/attachment'
import type { Attachment } from '../../types/attachment'
import type { CommandOptionValue } from '../../types/engineCommand'

interface CompactChatInputProps {
  onSend: (message: string, workspaceDir?: string, attachments?: Attachment[], engineOptions?: CommandOptionValue[]) => void
  onInterrupt: () => void
  disabled?: boolean
  isStreaming?: boolean
}

export function CompactChatInput({ onSend, onInterrupt, disabled, isStreaming }: CompactChatInputProps) {
  const { t } = useTranslation('chat')
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 添加附件
  const addAttachment = useCallback(async (file: File, source: 'paste' | 'drag' | 'select') => {
    const validation = validateAttachment(file)
    if (!validation.valid) {
      console.warn('[CompactChatInput] 附件验证失败:', validation.error)
      return
    }

    const attachment = await createAttachment(file, source)
    setAttachments(prev => {
      const newAttachments = [...prev, attachment]
      const totalValidation = validateAttachments(newAttachments)
      if (!totalValidation.valid) {
        console.warn('[CompactChatInput] 总附件验证失败:', totalValidation.error)
        return prev
      }
      return newAttachments
    })
  }, [])

  // 移除附件
  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  // 粘贴处理
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    let hasFiles = false
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          await addAttachment(file, 'paste')
          hasFiles = true
        }
      } else if (item.kind === 'file') {
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

  // 文件选择
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    for (const file of files) {
      await addAttachment(file, 'select')
    }
    e.target.value = ''
  }, [addAttachment])

  // 键盘事件
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Enter = 换行，Enter = 发送
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [value, attachments, disabled, isStreaming])

  // 发送
  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if ((disabled || isStreaming) && attachments.length === 0) return
    if (!trimmed && attachments.length === 0) return

    onSend(trimmed, undefined, attachments.length > 0 ? attachments : undefined, undefined)
    setValue('')
    setAttachments([])
  }, [value, disabled, isStreaming, attachments, onSend])

  const canSend = (value.trim() || attachments.length > 0) && !disabled && !isStreaming

  return (
    <div className="border-t border-border bg-background-elevated">
      {/* 附件预览 - 紧凑版 */}
      {attachments.length > 0 && (
        <div className="px-2 pt-2">
          <AttachmentPreview
            attachments={attachments}
            onRemove={removeAttachment}
          />
        </div>
      )}

      {/* 输入区域 */}
      <div className="flex items-end gap-1.5 p-2">
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
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || isStreaming}
          className="shrink-0 p-1.5 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors disabled:opacity-50"
          title={t('input.attachFile')}
        >
          <IconPaperclip size={16} />
        </button>

        {/* 文本输入 - 支持多行 */}
        <AutoResizingTextarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={t('input.placeholder')}
          className="flex-1 px-2 py-1.5 bg-background-surface border border-border rounded-lg text-text-primary placeholder:text-text-tertiary resize-none outline-none text-sm leading-relaxed focus:border-primary/50"
          disabled={disabled}
          maxHeight={120}
          minHeight={32}
        />

        {/* 发送/中断按钮 */}
        {isStreaming ? (
          <button
            onClick={onInterrupt}
            className="shrink-0 p-1.5 rounded-lg bg-danger text-white hover:bg-danger-hover transition-colors"
            title={t('input.interrupt')}
          >
            <IconStop size={16} />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="shrink-0 p-1.5 rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={t('input.send')}
          >
            <IconSend size={16} />
          </button>
        )}
      </div>

      {/* 提示 */}
      <div className="px-2 pb-1.5 flex items-center justify-between text-xs text-text-tertiary">
        <span>{t('input.hint')}</span>
        {value.length > 0 && <span>{value.length}</span>}
      </div>
    </div>
  )
}
