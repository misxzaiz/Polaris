/**
 * MediaBlockRenderer — 主聊天内联媒体块渲染器
 *
 * 渲染 AI 生成的图像/视频（MediaBlock），三态：生成中 / 完成 / 失败。
 * 完成态复用 ComicStudio 的 ImageView / VideoView（点击放大、下载、内联播放）。
 */

import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertTriangle, Image as ImageIcon } from 'lucide-react'
import type { MediaBlock } from '@/types'
import { ImageView, VideoView } from '@/components/ComicStudio'

interface MediaBlockRendererProps {
  block: MediaBlock
}

export const MediaBlockRenderer = memo(function MediaBlockRenderer({ block }: MediaBlockRendererProps) {
  const { t } = useTranslation('chat')

  // 失败态
  if (block.status === 'failed') {
    return (
      <div className="my-2 flex items-start gap-2 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <div className="font-medium">{t('media.failed', '媒体生成失败')}</div>
          {block.error && (
            <div className="text-xs text-red-400/80 mt-0.5 break-words">{block.error}</div>
          )}
        </div>
      </div>
    )
  }

  // 生成中（未完成或暂无 URL）
  if (block.status === 'generating' || !block.url) {
    const progress = typeof block.progress === 'number' ? block.progress : 0
    return (
      <div className="my-2 flex flex-col gap-2 px-4 py-4 rounded-lg bg-background-elevated border border-border max-w-[512px]">
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="w-4 h-4 shrink-0 animate-spin text-primary" />
          <span>{t('media.generating', '正在生成图像…')}</span>
          {progress > 0 && <span className="text-xs text-text-tertiary">{progress}%</span>}
        </div>
        {block.prompt && (
          <div className="flex items-start gap-1.5 text-xs text-text-tertiary">
            <ImageIcon className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="break-words line-clamp-2">{block.prompt}</span>
          </div>
        )}
        <div className="h-1 w-full rounded-full bg-background-surface overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${Math.max(5, progress)}%` }}
          />
        </div>
      </div>
    )
  }

  // 完成态
  return (
    <div className="my-2">
      {block.mediaType === 'video' ? (
        <VideoView src={block.url} maxWidth={512} />
      ) : (
        <ImageView
          src={block.url}
          alt={block.prompt || 'Generated image'}
          maxWidth={512}
          maxHeight={512}
        />
      )}
      {block.prompt && (
        <p className="mt-1 text-xs text-text-tertiary break-words line-clamp-2">{block.prompt}</p>
      )}
    </div>
  )
})
