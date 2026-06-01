/**
 * CharacterGallery — 角色设计画廊
 *
 * 以网格展示角色形象图及设计信息。
 * 点击图片可放大查看。
 */

import { useState } from 'react'
import { UserRound, ZoomIn } from 'lucide-react'
import { useComicStudioStore } from '@/stores/comicStudioStore'

/** 图片灯箱 */
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

/** 角色卡片 */
function CharacterCard({
  name,
  imageUrl,
  designPrompt,
}: {
  name: string
  imageUrl?: string
  designPrompt?: string
}) {
  const [showLightbox, setShowLightbox] = useState(false)
  const [imageError, setImageError] = useState(false)

  return (
    <>
      <div className="border border-border rounded-lg overflow-hidden bg-background-surface hover:border-primary/30 transition-colors">
        {/* 图片区 */}
        <div className="relative aspect-[3/4] bg-background-elevated overflow-hidden group">
          {imageUrl && !imageError ? (
            <>
              <img
                src={imageUrl}
                alt={name}
                className="w-full h-full object-cover"
                onError={() => setImageError(true)}
              />
              <button
                onClick={() => setShowLightbox(true)}
                className="absolute top-2 right-2 p-1.5 rounded bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                title="放大查看"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
            </>
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <UserRound className="w-12 h-12 text-text-tertiary" />
            </div>
          )}

          {/* 名字覆盖 */}
          <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
            <h4 className="text-sm font-medium text-white">{name}</h4>
          </div>
        </div>

        {/* 信息区 */}
        <div className="p-3">
          {designPrompt && (
            <p className="text-[10px] text-text-tertiary line-clamp-2 italic">
              {designPrompt.substring(0, 100)}
            </p>
          )}
        </div>
      </div>

      {showLightbox && imageUrl && (
        <Lightbox
          src={imageUrl}
          alt={name}
          onClose={() => setShowLightbox(false)}
        />
      )}
    </>
  )
}

export function CharacterGallery() {
  const characterDesigns = useComicStudioStore((s) => s.characterDesigns)

  if (characterDesigns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-secondary gap-3">
        <UserRound className="w-12 h-12 text-text-tertiary" />
        <p className="text-sm">暂无角色设计</p>
        <p className="text-xs text-text-tertiary">
          启动管线后将自动生成角色形象
        </p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
        {characterDesigns.map((design, idx) => (
          <CharacterCard
            key={idx}
            name={design.name}
            imageUrl={design.designImageUrl}
            designPrompt={design.designPrompt}
          />
        ))}
      </div>
    </div>
  )
}
