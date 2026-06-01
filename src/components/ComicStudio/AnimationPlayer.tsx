/**
 * AnimationPlayer — 漫剧动效播放器
 *
 * 播放生成的动画片段，支持逐个查看和网格预览。
 */

import { useState, useRef } from 'react'
import { Play, Pause, Film, Volume2, VolumeX } from 'lucide-react'
import { useComicStudioStore } from '@/stores/comicStudioStore'

/** 单个视频播放卡片 */
function VideoCard({
  panelNumber,
  videoUrl,
  duration,
}: {
  panelNumber: number
  videoUrl: string
  duration?: number
}) {
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(true)
  const [error, setError] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  const handlePlayToggle = () => {
    const video = videoRef.current
    if (!video) return

    if (playing) {
      video.pause()
    } else {
      video.play().catch(() => setError(true))
    }
    setPlaying(!playing)
  }

  const handleMuteToggle = () => {
    const video = videoRef.current
    if (!video) return
    video.muted = !muted
    setMuted(!muted)
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-background-surface hover:border-primary/30 transition-colors">
      {/* 视频区域 */}
      <div className="relative aspect-video bg-black overflow-hidden group">
        {!error ? (
          <video
            ref={videoRef}
            src={videoUrl}
            muted={muted}
            loop
            playsInline
            className="w-full h-full object-contain"
            onEnded={() => setPlaying(false)}
            onError={() => setError(true)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Film className="w-10 h-10 text-text-tertiary" />
          </div>
        )}

        {/* 播放控制覆盖层 */}
        {!error && (
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handlePlayToggle}
              className="p-3 rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors"
            >
              {playing ? (
                <Pause className="w-6 h-6" />
              ) : (
                <Play className="w-6 h-6" />
              )}
            </button>
          </div>
        )}

        {/* 底部控制栏 */}
        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-3 py-2 flex items-center justify-between">
          <span className="text-xs text-white/80">
            分镜 {panelNumber}
            {duration ? ` · ${duration}s` : ''}
          </span>
          {!error && (
            <button
              onClick={handleMuteToggle}
              className="p-1 rounded text-white/70 hover:text-white transition-colors"
            >
              {muted ? (
                <VolumeX className="w-3.5 h-3.5" />
              ) : (
                <Volume2 className="w-3.5 h-3.5" />
              )}
            </button>
          )}
        </div>

        {/* 播放状态指示 */}
        {playing && (
          <div className="absolute top-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded bg-green-500/80 text-white text-[10px]">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
            播放中
          </div>
        )}
      </div>

      {/* 信息区 */}
      <div className="px-3 py-1.5 border-t border-border">
        <p className="text-xs text-text-tertiary">
          分镜 {panelNumber} · {duration ? `${duration}s` : '--'}
        </p>
      </div>
    </div>
  )
}

export function AnimationPlayer() {
  const animationClips = useComicStudioStore((s) => s.animationClips)

  if (animationClips.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-secondary gap-3">
        <Film className="w-12 h-12 text-text-tertiary" />
        <p className="text-sm">暂无动画片段</p>
        <p className="text-xs text-text-tertiary">
          启动管线后将对关键分镜生成动效
        </p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {animationClips.map((clip, idx) => (
          <VideoCard
            key={idx}
            panelNumber={clip.panelNumber}
            videoUrl={clip.videoUrl}
            duration={clip.duration}
          />
        ))}
      </div>
    </div>
  )
}
