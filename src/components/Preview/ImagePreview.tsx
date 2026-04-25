import { useMemo } from 'react'

interface ImagePreviewProps {
  filePath?: string
  title?: string
}

export function ImagePreview({ filePath, title }: ImagePreviewProps) {
  const src = useMemo(() => {
    if (!filePath) return ''
    // In Tauri mode, use the native asset protocol; in web mode, fall back to empty
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      // Dynamic import to avoid bundling Tauri API in web mode
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { convertFileSrc } = require('@tauri-apps/api/core')
        return convertFileSrc(filePath)
      } catch {
        return ''
      }
    }
    return ''
  }, [filePath])

  if (!filePath) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary">
        <span className="text-sm">没有可预览的图片</span>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background-base">
      <div className="px-4 py-2 text-xs font-medium text-text-secondary bg-background-surface border-b border-border-subtle shrink-0">
        {title || filePath}
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="flex items-center justify-center">
          <img
            src={src}
            alt={title || filePath}
            className="max-w-full max-h-[80vh] object-contain rounded-md border border-border-subtle shadow-sm bg-background-surface"
            draggable={false}
          />
        </div>
      </div>
    </div>
  )
}
