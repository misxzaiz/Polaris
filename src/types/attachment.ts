/**
 * 附件类型定义
 *
 * 支持图片、文件等附件类型，用于输入框和消息系统
 */

/**
 * 附件来源
 */
export type AttachmentSource = 'paste' | 'drag' | 'select' | 'clipboard-image'

/**
 * 附件状态
 */
export type AttachmentStatus = 'pending' | 'loading' | 'ready' | 'error'

/**
 * 附件接口
 */
export interface Attachment {
  /** 唯一标识 */
  id: string
  /** 附件类型 */
  type: 'image' | 'file'
  /** 来源 */
  source: AttachmentSource
  /** 文件名 */
  fileName: string
  /** 文件大小 (bytes) */
  fileSize: number
  /** MIME 类型 */
  mimeType: string
  /** 二进制内容 (base64 data URL，用于图片) */
  content: string
  /** 文本内容（用于文本/代码文件，避免 base64 膨胀） */
  textContent?: string
  /** 图片预览 (缩略图) */
  preview?: string
  /** 状态 */
  status: AttachmentStatus
  /** 错误信息 */
  error?: string
}

/**
 * 附件约束配置
 */
export const ATTACHMENT_LIMITS = {
  /** 最大附件数量 */
  maxCount: 10,
  /** 单张图片最大尺寸 (20MB) */
  maxImageSize: 20 * 1024 * 1024,
  /** 单个文件最大尺寸 (50MB) */
  maxFileSize: 50 * 1024 * 1024,
  /** 总附件最大尺寸 (100MB) */
  maxTotalSize: 100 * 1024 * 1024,
  /** 支持的图片类型 */
  supportedImageTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'],
  /** 支持的文本文件类型 */
  supportedTextTypes: [
    'text/plain',
    'text/markdown',
    'text/html',
    'text/css',
    'text/javascript',
    'application/json',
    'application/xml',
    'text/xml',
    'text/yaml',
    'application/yaml',
  ],
  /** 支持的代码文件扩展名 */
  codeExtensions: [
    '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
    '.c', '.cpp', '.h', '.hpp', '.cs', '.php',
    '.sh', '.bash', '.zsh', '.ps1',
    '.sql', '.graphql',
    '.yaml', '.yml', '.toml', '.ini', '.conf',
    '.md', '.rst', '.txt', '.log',
  ],
} as const

/**
 * 判断是否为图片类型
 */
export function isImageType(mimeType: string): boolean {
  return mimeType.startsWith('image/')
}

/**
 * 判断是否为可预览的图片
 */
export function isPreviewableImage(mimeType: string): boolean {
  return (ATTACHMENT_LIMITS.supportedImageTypes as readonly string[]).includes(mimeType)
}

/**
 * 判断是否为文本文件
 */
export function isTextFile(mimeType: string, fileName: string): boolean {
  if ((ATTACHMENT_LIMITS.supportedTextTypes as readonly string[]).includes(mimeType)) {
    return true
  }
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'))
  return (ATTACHMENT_LIMITS.codeExtensions as readonly string[]).includes(ext)
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

/**
 * 生成唯一 ID
 */
export function generateAttachmentId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/**
 * 创建附件对象
 */
export async function createAttachment(
  file: File,
  source: AttachmentSource
): Promise<Attachment> {
  const id = generateAttachmentId()
  const isImage = isImageType(file.type)
  const isText = !isImage && isTextFile(file.type || '', file.name)

  const attachment: Attachment = {
    id,
    type: isImage ? 'image' : 'file',
    source,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
    content: '',
    status: 'loading',
  }

  try {
    if (isImage) {
      // 图片文件：使用 base64（用于预览和后端存盘）
      const content = await readFileAsBase64(file)
      attachment.content = content
      if (isPreviewableImage(file.type)) {
        attachment.preview = content
      }
    } else if (isText) {
      // 文本/代码文件：直接读取文本内容（避免 base64 膨胀）
      const text = await readFileAsText(file)
      attachment.textContent = text
      attachment.content = '' // 文本文件不需要 base64
    } else {
      // 其他二进制文件：使用 base64（后端会存盘）
      const content = await readFileAsBase64(file)
      attachment.content = content
    }

    attachment.status = 'ready'
  } catch (err) {
    attachment.status = 'error'
    attachment.error = err instanceof Error ? err.message : '读取文件失败'
  }

  return attachment
}

/**
 * 读取文件为 Base64
 */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('无法读取文件'))
      }
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * 读取文件为文本
 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('无法读取文件'))
      }
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsText(file)
  })
}

/**
 * 验证附件
 */
export function validateAttachment(file: File): { valid: boolean; error?: string } {
  const isImage = isImageType(file.type)
  const maxSize = isImage ? ATTACHMENT_LIMITS.maxImageSize : ATTACHMENT_LIMITS.maxFileSize

  if (file.size > maxSize) {
    return {
      valid: false,
      error: `文件过大，最大支持 ${formatFileSize(maxSize)}`,
    }
  }

  return { valid: true }
}

/**
 * 验证附件列表
 */
export function validateAttachments(
  attachments: Attachment[]
): { valid: boolean; error?: string } {
  if (attachments.length > ATTACHMENT_LIMITS.maxCount) {
    return {
      valid: false,
      error: `附件数量过多，最多支持 ${ATTACHMENT_LIMITS.maxCount} 个`,
    }
  }

  const totalSize = attachments.reduce((sum, a) => sum + a.fileSize, 0)
  if (totalSize > ATTACHMENT_LIMITS.maxTotalSize) {
    return {
      valid: false,
      error: `附件总大小过大，最大支持 ${formatFileSize(ATTACHMENT_LIMITS.maxTotalSize)}`,
    }
  }

  return { valid: true }
}

/**
 * 获取文件图标类型
 */
export function getFileIcon(mimeType: string, fileName: string): string {
  if (isImageType(mimeType)) return 'image'

  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'))

  // 代码文件
  if (['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte'].includes(ext)) return 'code'
  if (['.py', '.rb', '.go', '.rs', '.java'].includes(ext)) return 'code'
  if (['.c', '.cpp', '.h', '.hpp', '.cs'].includes(ext)) return 'code'

  // 配置文件
  if (['.json', '.yaml', '.yml', '.toml', '.ini'].includes(ext)) return 'config'

  // 文档
  if (['.md', '.txt', '.rst'].includes(ext)) return 'document'

  // 其他
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar')) return 'archive'

  return 'file'
}
