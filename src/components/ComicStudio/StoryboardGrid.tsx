/**
 * StoryboardGrid — 分镜网格
 *
 * 以漫画阅读顺序排列分镜插画，支持对话气泡叠加显示。
 */

import { useState } from 'react'
import { ImageIcon, ZoomIn, MessageCircle } from 'lucide-react'
import { useComicStudioStore } from '@/stores/comicStudioStore'

/** 图片灯箱 (同 CharacterGallery 中的实现) */
function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string
  alt: string
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center cursor-pointer"
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
      />
    </div>
  )
}

/** 单格分镜卡片 */
function PanelCard({
  pageNumber,
  panelNumber,
  imageUrl,
  prompt,
  dialogueOverlay,
}: {
  pageNumber: number
  panelNumber: number
  imageUrl: string
  prompt?: string
  dialogueOverlay?: { character: string; text: string; type?: string }[]
}) {
  const [showLightbox, setShowLightbox] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [showDialogue, setShowDialogue] = useState(true)

  return (
    <>
      <div className="border border-border rounded-lg overflow-hidden bg-background-surface hover:border-primary/30 transition-colors">
        {/* 页眉 */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-background-elevated border-b border-border">
          <span className="text-xs font-medium text-text-secondary">
            第{pageNumber}页 · 格{panelNumber}
          </span>
          <div className="flex items-center gap-1">
            {dialogueOverlay && dialogueOverlay.length > 0 && (
              <button
                onClick={() => setShowDialogue(!showDialogue)}
                className={`p-1 rounded transition-colors ${
                  showDialogue
                    ? 'text-blue-400 bg-blue-500/10'
                    : 'text-text-tertiary hover:text-text-secondary'
                }`}
                title="切换对话显示"
              >
                <MessageCircle className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={() => setShowLightbox(true)}
              className="p-1 rounded text-text-tertiary hover:text-text-secondary transition-colors"
              title="放大查看"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 图片 */}
        <div className="relative aspect-video bg-background-elevated overflow-hidden group">
          {!imageError ? (
            <img
              src={imageUrl}
              alt={`分镜 ${pageNumber}-${panelNumber}`}
              className="w-full h-full object-cover"
              onError={() => setImageError(true)}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <ImageIcon className="w-8 h-8 text-text-tertiary" />
            </div>
          )}

          {/* 对话气泡叠加层 */}
          {showDialogue && dialogueOverlay && dialogueOverlay.length > 0 && (
            <div className="absolute bottom-0 inset-x-0 p-2 space-y-1">
              {dialogueOverlay.map((d, di) => (
                <div
                  key={di}
                  className="bg-black/60 backdrop-blur-sm rounded px-2 py-1"
                >
                  <span className="text-[10px] font-medium text-blue-300">
                    {d.character}：
                  </span>
                  <span className="text-[10px] text-white/90">{d.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 提示词预览 */}
        {prompt && (
          <div className="px-3 py-1.5 border-t border-border">
            <p className="text-[10px] text-text-tertiary line-clamp-2 italic">
              {prompt.substring(0, 100)}
            </p>
          </div>
        )}
      </div>

      {showLightbox && !imageError && (
        <Lightbox
          src={imageUrl}
          alt={`分镜 ${pageNumber}-${panelNumber}`}
          onClose={() => setShowLightbox(false)}
        />
      )}
    </>
  )
}

/** 按页分组 */
function groupByPage(
  panels: {
    pageNumber: number
    panelNumber: number
    imageUrl: string
    prompt?: string
    dialogueOverlay?: { character: string; text: string; type?: string }[]
  }[],
): Map<number, typeof panels> {
  const map = new Map<number, typeof panels>()
  for (const p of panels) {
    const group = map.get(p.pageNumber) || []
    group.push(p)
    map.set(p.pageNumber, group)
  }
  return map
}

export function StoryboardGrid() {
  const storyboards = useComicStudioStore((s) => s.storyboards)

  if (storyboards.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-secondary gap-3">
        <ImageIcon className="w-12 h-12 text-text-tertiary" />
        <p className="text-sm">暂无分镜</p>
        <p className="text-xs text-text-tertiary">
          启动管线后将逐页生成分镜插画
        </p>
      </div>
    )
  }

  const grouped = groupByPage(storyboards)
  const sortedPages = Array.from(grouped.keys()).sort((a, b) => a - b)

  return (
    <div className="h-full overflow-y-auto p-4 space-y-6">
      {sortedPages.map((pageNum) => {
        const panels = grouped.get(pageNum) || []
        // 按 panelNumber 排序
        panels.sort((a, b) => a.panelNumber - b.panelNumber)

        return (
          <div key={pageNum}>
            <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              第 {pageNum} 页
              <span className="text-xs text-text-tertiary font-normal">
                ({panels.length} 格)
              </span>
            </h3>

            {/* 漫画阅读顺序：竖排或网格 */}
            <div className="grid grid-cols-1 gap-3">
              {panels.map((panel) => (
                <PanelCard
                  key={`${panel.pageNumber}-${panel.panelNumber}`}
                  pageNumber={panel.pageNumber}
                  panelNumber={panel.panelNumber}
                  imageUrl={panel.imageUrl}
                  prompt={panel.prompt}
                  dialogueOverlay={panel.dialogueOverlay}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
