/**
 * 附件预览组件
 *
 * 显示图片缩略图和文件图标，支持删除操作
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, FileText, Image, File, Loader2, AlertCircle } from 'lucide-react'
import type { Attachment } from '@/types/attachment'
import { formatFileSize, getFileIcon, isPreviewableImage } from '@/types/attachment'

interface AttachmentPreviewProps {
  attachments: Attachment[]
  onRemove: (id: string) => void
}

export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  if (attachments.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 p-2 bg-background-surface rounded-t-lg border-b border-border-subtle">
      {attachments.map((attachment) => (
        <AttachmentItem
          key={attachment.id}
          attachment={attachment}
          onRemove={() => onRemove(attachment.id)}
        />
      ))}
    </div>
  )
}

interface AttachmentItemProps {
  attachment: Attachment
  onRemove: () => void
}

function AttachmentItem({ attachment, onRemove }: AttachmentItemProps) {
  const { t } = useTranslation('chat')
  const [imageError, setImageError] = useState(false)
  const { type, fileName, fileSize, status, error, preview, mimeType } = attachment

  // 加载中状态
  if (status === 'loading') {
    return (
      <div className="relative flex items-center gap-2 px-3 py-2 bg-background-elevated rounded-lg border border-border-subtle">
        <Loader2 size={16} className="animate-spin text-text-tertiary" />
        <span className="text-sm text-text-secondary truncate max-w-[120px]">{fileName}</span>
      </div>
    )
  }

  // 错误状态
  if (status === 'error') {
    return (
      <div className="relative flex items-center gap-2 px-3 py-2 bg-danger/10 rounded-lg border border-danger/20">
        <AlertCircle size={16} className="text-danger" />
        <div className="flex flex-col">
          <span className="text-sm text-text-primary truncate max-w-[120px]">{fileName}</span>
          <span className="text-xs text-danger">{error || t('attachment.loadFailed')}</span>
        </div>
        <button
          onClick={onRemove}
          className="ml-1 p-0.5 rounded hover:bg-danger/20 text-danger"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  // 图片预览
  if (type === 'image' && preview && isPreviewableImage(mimeType) && !imageError) {
    return (
      <div className="relative group">
        <div className="w-16 h-16 rounded-lg overflow-hidden border border-border-subtle bg-background-elevated">
          <img
            src={preview}
            alt={fileName}
            className="w-full h-full object-cover"
            onError={() => setImageError(true)}
          />
        </div>
        {/* 删除按钮 */}
        <button
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 p-1 rounded-full bg-danger text-white opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
        >
          <X size={10} />
        </button>
        {/* 文件名提示 */}
        <div className="absolute -bottom-5 left-0 right-0 text-center">
          <span className="text-xs text-text-tertiary truncate block px-1">{fileName}</span>
        </div>
      </div>
    )
  }

  // 文件图标
  const iconType = getFileIcon(mimeType, fileName)
  const IconComponent = getFileIconComponent(iconType)

  return (
    <div className="relative group flex items-center gap-2 px-3 py-2 bg-background-elevated rounded-lg border border-border-subtle hover:border-border transition-colors">
      <IconComponent size={20} className={getIconColor(iconType)} />
      <div className="flex flex-col min-w-0">
        <span className="text-sm text-text-primary truncate max-w-[150px]">{fileName}</span>
        <span className="text-xs text-text-tertiary">{formatFileSize(fileSize)}</span>
      </div>
      {/* 删除按钮 */}
      <button
        onClick={onRemove}
        className="p-1 rounded hover:bg-background-hover text-text-tertiary hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X size={14} />
      </button>
    </div>
  )
}

function getFileIconComponent(iconType: string) {
  switch (iconType) {
    case 'image':
      return Image
    case 'pdf':
    case 'document':
    case 'config':
      return FileText
    default:
      return File
  }
}

function getIconColor(iconType: string): string {
  switch (iconType) {
    case 'image':
      return 'text-blue-500'
    case 'video':
      return 'text-red-500'
    case 'audio':
      return 'text-purple-500'
    case 'pdf':
      return 'text-red-600'
    case 'code':
      return 'text-green-500'
    case 'config':
      return 'text-yellow-600'
    case 'document':
      return 'text-blue-600'
    case 'archive':
      return 'text-orange-500'
    default:
      return 'text-text-secondary'
  }
}
