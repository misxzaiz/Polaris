/**
 * MediaMessage — 聊天媒体消息渲染组件
 *
 * 在聊天中以内联方式渲染生成的图像和视频，支持：
 * - 图片：点击放大灯箱
 * - 视频：内联播放控制
 * - 加载中状态
 * - 错误回退
 */

import { useState, useRef, useCallback } from 'react'
import {
  Video,
  Play,
  Pause,
  ZoomIn,
  Download,
  AlertTriangle,
  Loader2,
  ExternalLink,
} from 'lucide-react'

// ========================================
// ImageView — 可点击放大的图片组件
// ========================================

interface ImageViewProps {
  src: string
  alt?: string
  className?: string
  /** 容器最大宽度 */
  maxWidth?: number
  /** 容器最大高度 */
  maxHeight?: number
  /** 是否显示下载按钮 */
  showDownload?: boolean
}

export function ImageView({
  src,
  alt = 'Generated image',
  className = '',
  maxWidth = 512,
  maxHeight = 384,
  showDownload = true,
}: ImageViewProps) {
  const [showLightbox, setShowLightbox] = useState(false)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') setShowLightbox(false)
    },
    [],
  )

  if (error) {
    return (
      <div
        className={`flex items-center gap-2 px-4 py-3 rounded-md bg-red-500/10 border border-red-500/20 text-sm text-red-400 ${className}`}
      >
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span>图片加载失败</span>
      </div>
    )
  }

  return (
    <>
      {/* 内联缩略图 */}
      <div
        className={`relative group overflow-hidden rounded-lg border border-border bg-background-elevated ${className}`}
        style={{ maxWidth, maxHeight }}
        role="button"
        tabIndex={0}
        onClick={() => loaded && setShowLightbox(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && loaded) setShowLightbox(true)
        }}
      >
        {/* 加载占位 */}
        {!loaded && (
          <div
            className="flex items-center justify-center bg-background-surface"
            style={{ width: maxWidth, height: Math.min(maxHeight, 256) }}
          >
            <Loader2 className="w-6 h-6 text-text-tertiary animate-spin" />
          </div>
        )}

        <img
          src={src}
          alt={alt}
          className={`w-full object-contain ${loaded ? '' : 'absolute inset-0 opacity-0'}`}
          style={{ maxHeight }}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />

        {/* 悬停覆盖 */}
        {loaded && (
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
            <div className="flex items-center gap-1">
              <button
                className="p-2 rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowLightbox(true)
                }}
                title="放大查看"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              {showDownload && (
                <a
                  href={src}
                  download
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-2 rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors"
                  onClick={(e) => e.stopPropagation()}
                  title="下载"
                >
                  <Download className="w-4 h-4" />
                </a>
              )}
              <a
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors"
                onClick={(e) => e.stopPropagation()}
                title="新窗口打开"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </div>
        )}
      </div>

      {/* 灯箱 */}
      {showLightbox && loaded && (
        <div
          className="fixed inset-0 z-[70] bg-black/85 flex items-center justify-center cursor-pointer animate-in fade-in"
          onClick={() => setShowLightbox(false)}
          onKeyDown={handleKeyDown}
          role="dialog"
          aria-label={alt}
        >
          <img
            src={src}
            alt={alt}
            className="max-w-[92vw] max-h-[92vh] object-contain rounded-lg shadow-2xl"
          />
          <button
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors text-sm"
            onClick={() => setShowLightbox(false)}
          >
            ESC
          </button>
        </div>
      )}
    </>
  )
}

// ========================================
// VideoView — 内联视频播放器
// ========================================

interface VideoViewProps {
  src: string
  poster?: string
  className?: string
  maxWidth?: number
  muted?: boolean
  loop?: boolean
}

export function VideoView({
  src,
  poster,
  className = '',
  maxWidth = 512,
  muted = true,
  loop = true,
}: VideoViewProps) {
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  const handlePlayPause = () => {
    const video = videoRef.current
    if (!video) return

    if (playing) {
      video.pause()
    } else {
      video.play().catch(() => setError(true))
    }
    setPlaying(!playing)
  }

  if (error) {
    return (
      <div className={`flex items-center gap-2 px-4 py-3 rounded-md bg-red-500/10 border border-red-500/20 text-sm text-red-400 ${className}`}>
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span>视频加载失败</span>
      </div>
    )
  }

  return (
    <div
      className={`relative group overflow-hidden rounded-lg border border-border bg-black ${className}`}
      style={{ maxWidth }}
    >
      {/* 加载指示器 */}
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-black">
          <Loader2 className="w-6 h-6 text-text-tertiary animate-spin" />
        </div>
      )}

      <video
        ref={videoRef}
        src={src}
        poster={poster}
        muted={muted}
        loop={loop}
        playsInline
        preload="metadata"
        className={`w-full ${loaded ? '' : 'opacity-0'}`}
        onLoadedData={() => setLoaded(true)}
        onError={() => setError(true)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />

      {/* 播放控制覆盖 */}
      {loaded && (
        <>
          {/* 中央播放按钮 */}
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handlePlayPause}
              className="p-3 rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors"
            >
              {playing ? (
                <Pause className="w-6 h-6" />
              ) : (
                <Play className="w-6 h-6" />
              )}
            </button>
          </div>

          {/* 底部信息栏 */}
          <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-3 py-1.5 flex items-center justify-between">
            <span className="text-xs text-white/70 flex items-center gap-1.5">
              {playing ? (
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              ) : (
                <Video className="w-3 h-3" />
              )}
              {playing ? '播放中' : '视频'}
            </span>
            <a
              href={src}
              download
              target="_blank"
              rel="noopener noreferrer"
              className="p-1 rounded text-white/50 hover:text-white/80 transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              <Download className="w-3 h-3" />
            </a>
          </div>
        </>
      )}
    </div>
  )
}

// ========================================
// MediaMessage — 聊天消息中的媒体容器
// ========================================

interface MediaMessageProps {
  /** 媒体类型 */
  type: 'image' | 'video'
  /** 媒体 URL */
  src: string
  /** 可选：生成提示词 */
  prompt?: string
  /** 可选：替代文本 */
  alt?: string
  className?: string
}

export function MediaMessage({
  type,
  src,
  prompt,
  alt,
  className = '',
}: MediaMessageProps) {
  return (
    <div className={`space-y-2 my-2 ${className}`}>
      {type === 'image' ? (
        <ImageView src={src} alt={alt || prompt || 'AI Generated Image'} />
      ) : (
        <VideoView src={src} />
      )}

      {/* 提示词展示 */}
      {prompt && (
        <details className="text-xs">
          <summary className="text-text-tertiary cursor-pointer hover:text-text-secondary transition-colors">
            生成提示词
          </summary>
          <p className="mt-1 p-2 rounded bg-background-surface border border-border text-text-secondary whitespace-pre-wrap">
            {prompt}
          </p>
        </details>
      )}
    </div>
  )
}
