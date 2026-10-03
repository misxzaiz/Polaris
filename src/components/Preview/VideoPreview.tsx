import { useMemo } from 'react'
import { buildFilePreviewUrl } from '@/services/tauri/fileService'

interface VideoPreviewProps {
  filePath?: string
  title?: string
}

export function VideoPreview({ filePath, title }: VideoPreviewProps) {
  const src = useMemo(() => {
    if (!filePath) return ''
    return buildFilePreviewUrl(filePath)
  }, [filePath])

  if (!filePath) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary">
        <span className="text-sm">没有可预览的视频</span>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background-base">
      <div className="px-4 py-2 text-xs font-medium text-text-secondary bg-background-surface border-b border-border-subtle shrink-0">
        {title || filePath}
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="flex items-center justify-center h-full min-h-[240px]">
          {src ? (
            <video
              src={src}
              controls
              controlsList="nodownload"
              playsInline
              preload="metadata"
              className="max-w-full max-h-[80vh] rounded-md border border-border-subtle shadow-sm bg-black"
              style={{ width: '100%', objectFit: 'contain' }}
            >
              <p className="text-sm text-text-tertiary">
                当前环境不支持视频预览，可尝试用系统播放器打开
              </p>
            </video>
          ) : (
            <span className="text-sm text-text-tertiary">
              当前环境不支持视频预览
            </span>
          )}
        </div>
      </div>
    </div>
  )
}