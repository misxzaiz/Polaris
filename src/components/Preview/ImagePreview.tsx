import { useEffect, useMemo, useState } from 'react'
import { buildFilePreviewUrl, buildSvgBlobUrl } from '@/services/tauri/fileService'

interface ImagePreviewProps {
  filePath?: string
  title?: string
}

/** 判断是否为 SVG（Tauri asset 协议默认禁渲染，需走 Blob 读取） */
function isSvgPath(filePath?: string): boolean {
  return !!filePath && filePath.split('.').pop()?.toLowerCase() === 'svg'
}

export function ImagePreview({ filePath, title }: ImagePreviewProps) {
  const isSvg = useMemo(() => isSvgPath(filePath), [filePath])
  const [svgSrc, setSvgSrc] = useState<string>('')

  // SVG：双端统一走文本读取 → Blob URL，避开 Tauri asset:// 禁 SVG 的问题
  useEffect(() => {
    let revoked = false
    let objectUrl = ''
    if (filePath && isSvg) {
      buildSvgBlobUrl(filePath).then((url) => {
        if (!url) return
        objectUrl = url
        if (!revoked) setSvgSrc(url)
        else URL.revokeObjectURL(url)
      })
    } else {
      setSvgSrc('')
    }
    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [filePath, isSvg])

  const src = useMemo(() => {
    if (!filePath) return ''
    if (isSvg) return svgSrc
    return buildFilePreviewUrl(filePath)
  }, [filePath, isSvg, svgSrc])

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
          {src ? (
            <img
              src={src}
              alt={title || filePath}
              className="max-w-full max-h-[80vh] object-contain rounded-md border border-border-subtle shadow-sm bg-background-surface"
              draggable={false}
            />
          ) : (
            <span className="text-sm text-text-tertiary">
              当前环境不支持图片预览
            </span>
          )}
        </div>
      </div>
    </div>
  )
}