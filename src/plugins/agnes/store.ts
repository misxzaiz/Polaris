/**
 * Agnes 媒体状态存储。
 *
 * 把生图/生视频的状态从面板子组件的 useState 上提到模块作用域，
 * 使 Tab 切换、面板切换不再丢失内容；视频轮询 timer 也由 store 持有，
 * 组件卸载不会中断在跑的任务。
 *
 * 持久化策略（persist → localStorage）：
 *  - 持久化：prompt 草稿、图片/视频历史元数据（仅 http URL，不含 base64）、
 *    选中项（size/mode/preset 等）。
 *  - 不持久化：base64 上传图（inputImages/video.image/video.images）、
 *    loading/error 等瞬态、轮询 timer。
 *
 * 重启后：对 video.history 中 queued/in_progress 的任务自动续轮询。
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  agnesCreateVideo,
  agnesGenerateImage,
  agnesQueryVideo,
  FRAME_PRESETS,
  toDataUrl,
  type AgnesImageResult,
  type AgnesVideoTask,
} from './api'

// ============================================================================
// 类型
// ============================================================================

export interface ImageHistoryItem {
  prompt: string
  size: string
  src: string // http URL 或 data URL；仅 http 项会被持久化
  model: string
  createdAt: number
}

export interface VideoHistoryItem {
  prompt: string
  videoId: string
  status: string
  progress: number
  url: string | null
  seconds: string | null
  size: string | null
  error: string | null
  createdAt: number
}

type ImageMode = 'text' | 'image'
type VideoMode = 'text' | 'image' | 'multi' | 'keyframes'

interface AgnesMediaState {
  // 生图
  image: {
    prompt: string
    size: string
    mode: ImageMode
    inputImages: string[] // base64 data URL，不持久化
    responseFormat: 'url' | 'b64_json'
    history: ImageHistoryItem[]
    loading: boolean
    error: string | null
  }
  // 生视频
  video: {
    prompt: string
    presetIdx: number
    mode: VideoMode
    image: string | null // base64 data URL，不持久化
    images: string[] // base64 data URL，不持久化
    negativePrompt: string
    seed: string
    history: VideoHistoryItem[]
    loading: boolean
    error: string | null
  }
}

interface AgnesMediaActions {
  // 生图 actions
  setImagePrompt: (v: string) => void
  setImageSize: (v: string) => void
  setImageMode: (m: ImageMode) => void
  addInputImages: (imgs: string[]) => void
  removeInputImage: (i: number) => void
  setResponseFormat: (f: 'url' | 'b64_json') => void
  generateImage: () => Promise<void>
  clearImageError: () => void

  // 生视频 actions
  setVideoPrompt: (v: string) => void
  setPresetIdx: (i: number) => void
  setVideoMode: (m: VideoMode) => void
  setVideoImage: (img: string | null) => void
  addVideoImages: (imgs: string[]) => void
  removeVideoImage: (i: number) => void
  setNegativePrompt: (v: string) => void
  setSeed: (v: string) => void
  createVideo: () => Promise<void>
  queryVideo: (videoId: string) => Promise<void>
  clearVideoError: () => void

  // 内部：轮询回写
  _applyVideoUpdate: (videoId: string, task: AgnesVideoTask) => void
}

const MAX_IMAGE_HISTORY = 12
const MAX_VIDEO_HISTORY = 8
const POLL_INTERVAL_MS = 5000

// ============================================================================
// 轮询 timer（模块作用域，不进 store state，不触发渲染）
// ============================================================================

const pollTimers = new Map<string, ReturnType<typeof setInterval>>()

function startPolling(videoId: string): void {
  if (pollTimers.has(videoId)) return
  const tick = async () => {
    try {
      const task = await agnesQueryVideo(videoId)
      useAgnesMediaStore.getState()._applyVideoUpdate(videoId, task)
      if (task.status === 'completed' || task.status === 'failed') {
        stopPolling(videoId)
      }
    } catch (e) {
      console.error('[Agnes] poll failed', e)
    }
  }
  pollTimers.set(videoId, setInterval(tick, POLL_INTERVAL_MS))
  void tick() // 立即查一次
}

function stopPolling(videoId: string): void {
  const t = pollTimers.get(videoId)
  if (t !== undefined) {
    clearInterval(t)
    pollTimers.delete(videoId)
  }
}

// ============================================================================
// Store
// ============================================================================

const initialState: AgnesMediaState = {
  image: {
    prompt: '',
    size: '1024x1024',
    mode: 'text',
    inputImages: [],
    responseFormat: 'url',
    history: [],
    loading: false,
    error: null,
  },
  video: {
    prompt: '',
    presetIdx: 1,
    mode: 'text',
    image: null,
    images: [],
    negativePrompt: '',
    seed: '',
    history: [],
    loading: false,
    error: null,
  },
}

export const useAgnesMediaStore = create<AgnesMediaState & AgnesMediaActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      // ===== 生图 =====
      setImagePrompt: (v) => set((s) => ({ image: { ...s.image, prompt: v } })),
      setImageSize: (v) => set((s) => ({ image: { ...s.image, size: v } })),
      setImageMode: (m) => set((s) => ({ image: { ...s.image, mode: m } })),
      addInputImages: (imgs) =>
        set((s) => ({
          image: { ...s.image, inputImages: [...s.image.inputImages, ...imgs].slice(0, 4) },
        })),
      removeInputImage: (i) =>
        set((s) => ({
          image: {
            ...s.image,
            inputImages: s.image.inputImages.filter((_, idx) => idx !== i),
          },
        })),
      setResponseFormat: (f) => set((s) => ({ image: { ...s.image, responseFormat: f } })),
      clearImageError: () => set((s) => ({ image: { ...s.image, error: null } })),

      generateImage: async () => {
        const { image } = get()
        if (!image.prompt.trim() || image.loading) return
        set((s) => ({ image: { ...s.image, loading: true, error: null } }))
        try {
          const result: AgnesImageResult = await agnesGenerateImage({
            prompt: image.prompt.trim(),
            size: image.size,
            images: image.mode === 'image' ? image.inputImages : undefined,
            responseFormat: image.responseFormat,
          })
          const src = result.url ?? (result.base64 ? toDataUrl(result.base64, result.mimeType ?? 'image/png') : '')
          if (!src) throw new Error('响应缺少 url 或 base64')
          const item: ImageHistoryItem = {
            prompt: image.prompt.trim(),
            size: image.size,
            src,
            model: result.model,
            createdAt: Date.now(),
          }
          set((s) => ({
            image: { ...s.image, loading: false, history: [item, ...s.image.history].slice(0, MAX_IMAGE_HISTORY) },
          }))
        } catch (e) {
          set((s) => ({ image: { ...s.image, loading: false, error: e instanceof Error ? e.message : String(e) } }))
        }
      },

      // ===== 生视频 =====
      setVideoPrompt: (v) => set((s) => ({ video: { ...s.video, prompt: v } })),
      setPresetIdx: (i) => set((s) => ({ video: { ...s.video, presetIdx: i } })),
      setVideoMode: (m) => set((s) => ({ video: { ...s.video, mode: m } })),
      setVideoImage: (img) => set((s) => ({ video: { ...s.video, image: img } })),
      addVideoImages: (imgs) =>
        set((s) => ({
          video: { ...s.video, images: [...s.video.images, ...imgs].slice(0, 4) },
        })),
      removeVideoImage: (i) =>
        set((s) => ({
          video: { ...s.video, images: s.video.images.filter((_, idx) => idx !== i) },
        })),
      setNegativePrompt: (v) => set((s) => ({ video: { ...s.video, negativePrompt: v } })),
      setSeed: (v) => set((s) => ({ video: { ...s.video, seed: v } })),
      clearVideoError: () => set((s) => ({ video: { ...s.video, error: null } })),

      createVideo: async () => {
        const { video } = get()
        if (!video.prompt.trim() || video.loading) return
        set((s) => ({ video: { ...s.video, loading: true, error: null } }))
        try {
          const preset = FRAME_PRESETS[video.presetIdx] ?? FRAME_PRESETS[1]
          const task: AgnesVideoTask = await agnesCreateVideo({
            prompt: video.prompt.trim(),
            numFrames: preset.frames,
            frameRate: preset.rate,
            image: video.mode === 'image' && video.image ? video.image : undefined,
            images: video.mode === 'multi' || video.mode === 'keyframes' ? video.images : undefined,
            mode: video.mode === 'image' ? 'ti2vid' : video.mode === 'keyframes' ? 'keyframes' : undefined,
            negativePrompt: video.negativePrompt.trim() || undefined,
            seed: video.seed.trim() ? Number(video.seed) : undefined,
          })
          if (task.framesNormalized) {
            set((s) => ({ video: { ...s.video, error: '帧数已自动纠正为合法值 8n+1。' } }))
          }
          const item: VideoHistoryItem = {
            prompt: video.prompt.trim(),
            videoId: task.videoId,
            status: task.status,
            progress: task.progress,
            url: null,
            seconds: task.seconds,
            size: null,
            error: null,
            createdAt: Date.now(),
          }
          set((s) => ({
            video: { ...s.video, loading: false, history: [item, ...s.video.history].slice(0, MAX_VIDEO_HISTORY) },
          }))
          startPolling(task.videoId)
        } catch (e) {
          set((s) => ({ video: { ...s.video, loading: false, error: e instanceof Error ? e.message : String(e) } }))
        }
      },

      queryVideo: async (videoId) => {
        try {
          const task = await agnesQueryVideo(videoId)
          get()._applyVideoUpdate(videoId, task)
        } catch (e) {
          console.error('[Agnes] query failed', e)
        }
      },

      _applyVideoUpdate: (videoId, task) =>
        set((s) => ({
          video: {
            ...s.video,
            history: s.video.history.map((item) =>
              item.videoId === videoId
                ? {
                    ...item,
                    status: task.status,
                    progress: task.progress,
                    url: task.url ?? item.url,
                    seconds: task.seconds ?? item.seconds,
                    size: task.size ?? item.size,
                    error: task.error ?? item.error,
                  }
                : item,
            ),
          },
        })),
    }),
    {
      name: 'agnes-media',
      // 仅持久化轻量字段：草稿 + 历史元数据（排除 base64 上传图与瞬态）。
      partialize: (state) => ({
        image: {
          prompt: state.image.prompt,
          size: state.image.size,
          mode: state.image.mode,
          inputImages: [], // base64 不持久化
          responseFormat: state.image.responseFormat,
          // 仅保留 http URL 历史，base64 data URL 项丢弃（避免 localStorage 溢出）
          history: state.image.history.filter((h) => h.src.startsWith('http')),
          loading: false,
          error: null,
        },
        video: {
          prompt: state.video.prompt,
          presetIdx: state.video.presetIdx,
          mode: state.video.mode,
          image: null, // base64 不持久化
          images: [], // base64 不持久化
          negativePrompt: state.video.negativePrompt,
          seed: state.video.seed,
          history: state.video.history, // 元数据小，全持久化
          loading: false,
          error: null,
        },
      }),
      onRehydrateStorage: () => (state) => {
        // 重启后对未完成的视频任务续轮询。
        if (!state) return
        for (const item of state.video.history) {
          if (item.status === 'queued' || item.status === 'in_progress') {
            startPolling(item.videoId)
          }
        }
      },
    },
  ),
)
