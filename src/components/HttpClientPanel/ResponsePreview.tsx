/**
 * 响应预览：图片 / HTML / XML 渲染
 *
 * 根据 Content-Type 与响应体特征自动选择渲染方式：
 * - 图片：data: URL 直接预览（二进制响应体已转为 lossy 字符串，需后端提供 base64，此处尝试 data URL 文本识别）
 * - HTML：iframe srcdoc 渲染（sandbox 隔离）
 * - XML：CodeMirror 高亮回退
 *
 * 注：当前后端 response.body 是 UTF-8 lossy 字符串，二进制图片无法直接预览。
 * 因此图片预览仅支持 URL 形式（如 httpbin/image 返回的 base64 data URL 或前端可识别的图片链接）。
 * 真正的二进制预览留待后续后端扩展 base64 字段。
 */

import { useMemo } from 'react'

interface ResponsePreviewProps {
  body: string
  contentType: string
}

export function ResponsePreview({ body, contentType }: ResponsePreviewProps) {
  const ct = contentType.toLowerCase()
  const isHtml = ct.includes('text/html') || /^\s*<!doctype html|<html/i.test(body.trimStart())
  const isXml = ct.includes('xml') || /^\s*<\?xml/.test(body.trimStart())
  const isImage = ct.startsWith('image/')

  const imageUrl = useMemo(() => {
    // data URL 直接用
    if (isImage && /^data:image\//.test(body.trim())) return body.trim()
    // 若 body 看起来是纯图片 URL
    if (isImage && /^https?:\/\//.test(body.trim())) return body.trim()
    return null
  }, [isImage, body])

  if (isImage && imageUrl) {
    return (
      <div className="flex items-center justify-center p-4 h-full overflow-auto">
        <img src={imageUrl} alt="response" className="max-w-full max-h-full object-contain" />
      </div>
    )
  }

  if (isImage && !imageUrl) {
    return (
      <div className="p-3 text-xs text-text-tertiary">
        响应为图片二进制，当前预览仅支持 data URL / 图片链接形式。
      </div>
    )
  }

  if (isHtml) {
    return (
      <iframe
        title="html-preview"
        srcDoc={body}
        sandbox="allow-same-origin"
        className="w-full h-full bg-white border-0"
      />
    )
  }

  if (isXml) {
    return (
      <pre className="p-2 text-[11px] font-mono whitespace-pre-wrap break-all text-text-primary overflow-auto h-full">
        {body}
      </pre>
    )
  }

  return (
    <div className="p-3 text-xs text-text-tertiary">无可用预览（Content-Type: {contentType || 'unknown'}）</div>
  )
}
