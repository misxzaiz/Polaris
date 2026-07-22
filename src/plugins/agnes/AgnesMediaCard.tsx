/**
 * Agnes 多模态 MCP 卡片渲染器
 *
 * 接 PluginChatCardProps，从 data（MCP tool_result 的 structuredContent）
 * 提取字段，直接渲染生成的图片 / 视频，避免依赖 AI 文本输出裸 markdown。
 *
 * 数据形态（与 agnes_mcp_server.rs 的 structuredContent 对齐）：
 *   图片 url 模式：  { type:'image', url, model?, size?, prompt?, revisedPrompt? }
 *   图片 base64 模式：{ type:'image', base64, mimeType?, model?, size?, prompt?, revisedPrompt? }
 *   视频完成：      { type:'video', url, videoId?, status:'completed', seconds?, size?, model?, prompt? }
 *   视频进行中：    { type:'video', videoId, status, progress?, waiting:true }
 */

import { memo, useMemo } from 'react'
import { Download, ExternalLink, Film, Image as ImageIcon, Loader2 } from 'lucide-react'
import type { PluginChatCardProps } from '@/plugin-system/types'

interface MediaData {
  type?: string
  // image
  url?: string
  base64?: string
  mimeType?: string
  // video
  videoId?: string
  status?: string
  progress?: number
  seconds?: string
  size?: string
  waiting?: boolean
  // common
  model?: string
  prompt?: string
  revisedPrompt?: string
  error?: string
}

function isMediaData(data: unknown): data is MediaData {
  if (typeof data !== 'object' || data === null) return false
  const d = data as MediaData
  if (d.type !== 'image' && d.type !== 'video') return false
  if (d.type === 'image') return typeof d.url === 'string' || typeof d.base64 === 'string'
  return true
}

function buildImageSrc(d: MediaData): string | null {
  if (d.url) return d.url
  if (d.base64) {
    const mime = d.mimeType || 'image/png'
    return `data:${mime};base64,${d.base64}`
  }
  return null
}

async function download(url: string, filename: string) {
  try {
    const resp = await fetch(url)
    const blob = await resp.blob()
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(objUrl)
  } catch {
    // 回退到直接打开
    window.open(url, '_blank', 'noopener')
  }
}

export const AgnesMediaCard = memo(function AgnesMediaCard(props: PluginChatCardProps) {
  const data = useMemo<MediaData | null>(() => (isMediaData(props.data) ? props.data : null), [props.data])

  if (!data) {
    return (
      <div className="my-2 rounded-lg border border-border bg-background-elevated px-3 py-2 text-xs text-text-secondary">
        Agnes 媒体数据解析失败（{props.toolName}）
      </div>
    )
  }

  if (data.type === 'image') {
    return <ImageCard d={data} />
  }
  return <VideoCard d={data} />
})

// ============================================================================
// 图片
// ============================================================================

function ImageCard({ d }: { d: MediaData }) {
  const src = buildImageSrc(d)
  if (!src) {
    return (
      <div className="my-2 rounded-lg border border-border bg-background-elevated px-3 py-2 text-xs text-text-secondary">
        图片数据缺失
      </div>
    )
  }

  const meta = [d.model, d.size].filter(Boolean).join(' · ')
  const onDownload = () => {
    const ext = d.mimeType?.includes('jpeg') ? 'jpg' : 'png'
    download(src, `agnes-${Date.now()}.${ext}`)
  }

  return (
    <section className="my-2 w-full overflow-hidden rounded-lg border border-border bg-background-elevated">
      <header className="flex min-w-0 items-center gap-2 border-b border-border bg-background-surface px-3 py-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-fuchsia-500/10 text-fuchsia-400">
          <ImageIcon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary">Agnes 图片</div>
          {meta && <div className="mt-0.5 truncate text-[11px] text-text-tertiary">{meta}</div>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary"
            title="新窗口打开"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            onClick={onDownload}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary"
            title="下载"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      <div className="flex items-center justify-center bg-background-surface p-2">
        <img
          src={src}
          alt={d.prompt || d.revisedPrompt || 'Agnes 生成图片'}
          className="max-h-[420px] w-auto max-w-full rounded-md object-contain"
          loading="lazy"
        />
      </div>
      {(d.prompt || d.revisedPrompt) && (
        <div className="border-t border-border px-3 py-2 text-[11px] leading-relaxed text-text-secondary">
          {d.revisedPrompt || d.prompt}
        </div>
      )}
    </section>
  )
}

// ============================================================================
// 视频
// ============================================================================

function VideoCard({ d }: { d: MediaData }) {
  const completed = d.status === 'completed' && d.url
  const meta = [d.model, d.seconds && `${d.seconds}s`, d.size].filter(Boolean).join(' · ')

  const onDownload = () => {
    if (d.url) download(d.url, `agnes-${d.videoId || Date.now()}.mp4`)
  }

  return (
    <section className="my-2 w-full overflow-hidden rounded-lg border border-border bg-background-elevated">
      <header className="flex min-w-0 items-center gap-2 border-b border-border bg-background-surface px-3 py-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-400">
          <Film className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary">Agnes 视频</div>
          {meta && <div className="mt-0.5 truncate text-[11px] text-text-tertiary">{meta}</div>}
        </div>
        {completed && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <a
              href={d.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary"
              title="新窗口打开"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              type="button"
              onClick={onDownload}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary"
              title="下载"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </header>

      {completed ? (
        <div className="bg-black p-2">
          <video
            src={d.url}
            controls
            className="max-h-[460px] w-full rounded-md"
            preload="metadata"
          />
        </div>
      ) : (
        <div className="flex items-center gap-3 bg-background-surface px-3 py-6">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-indigo-400" />
          <div className="min-w-0 flex-1">
            <div className="text-sm text-text-primary">
              {d.status === 'failed' ? '视频生成失败' : '视频生成中...'}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-text-tertiary">
              {d.error
                ? d.error
                : d.videoId
                  ? `videoId: ${d.videoId}${typeof d.progress === 'number' ? ` · 进度 ${d.progress}%` : ''}`
                  : '等待任务创建'}
            </div>
          </div>
        </div>
      )}

      {d.prompt && (
        <div className="border-t border-border px-3 py-2 text-[11px] leading-relaxed text-text-secondary">
          {d.prompt}
        </div>
      )}
    </section>
  )
}
