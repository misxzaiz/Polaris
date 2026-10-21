/**
 * useRadioBroadcast — AI 连续语音播报的 UI 消费 hook
 *
 * 读 useRadioBroadcastStore（控制器快照投影），返回状态 + action。
 * 组件经本 hook 访问，不直连控制器/store 内部实现（对齐 AGENTS.md hooks 约束）。
 */
import { useCallback } from 'react'
import { useRadioBroadcastStore } from '@/stores/radioBroadcastStore'
import { DIRECTION_PRESETS, MIMO_VOICES } from '@/services/voiceBroadcast/constants'
import type { RadioBroadcastControllerOptions } from '@/services/voiceBroadcast/radioBroadcastController'
import type { RadioBroadcastDirection, VoiceId } from '@/services/voiceBroadcast/types'
import type { LibraryItem } from '@/services/voiceBroadcast/voiceService'

export interface UseRadioBroadcastReturn {
  status: ReturnType<typeof useRadioBroadcastStore.getState>['status']
  direction: RadioBroadcastDirection
  voice: VoiceId
  segment: ReturnType<typeof useRadioBroadcastStore.getState>['segment']
  segmentCount: number
  error: string | null
  nowPlayingText: string | null
  isPlaying: boolean
  /** 是否在播报中（含 starting/generating/stopping） */
  isActive: boolean
  /** 本次播报开始时刻（未开始为 0） */
  startedAt: number
  /** 轮次上限（本次生效） */
  maxRounds?: number
  /** 时长上限（秒） */
  maxSeconds?: number
  /** 最近停止原因（回 idle 后保留一次） */
  stopReason: ReturnType<typeof useRadioBroadcastStore.getState>['stopReason']
  /** 字幕跟读文稿（P0-1；无可展示内容为 null） */
  transcript: ReturnType<typeof useRadioBroadcastStore.getState>['transcript']
  /** 睡眠定时到点时刻（0 = 未设） */
  sleepUntil: number
  /** 睡眠定时「播完本段」模式 */
  sleepAfterSegment: boolean

  start: (opts: RadioBroadcastControllerOptions) => Promise<void>
  stop: () => Promise<void>
  pause: () => void
  resume: () => void
  /** 播放倍速（P0-2，即时生效） */
  setRate: (rate: number) => void
  /** 睡眠定时（P0-3）：分钟档 / 播完本段 / null 取消 */
  sleep: (opts: { minutes?: number; afterSegment?: boolean } | null) => void
  /** 回听内容库单集（P1：无 AI 会话直插已合成句子，播完即止） */
  playLibraryItem: (item: LibraryItem) => Promise<boolean>

  /** 方向预设（UI 选项） */
  directionPresets: typeof DIRECTION_PRESETS
  /** 预置音色（UI 选项） */
  voices: typeof MIMO_VOICES
}

export function useRadioBroadcast(): UseRadioBroadcastReturn {
  const status = useRadioBroadcastStore((s) => s.status)
  const direction = useRadioBroadcastStore((s) => s.direction)
  const voice = useRadioBroadcastStore((s) => s.voice)
  const segment = useRadioBroadcastStore((s) => s.segment)
  const segmentCount = useRadioBroadcastStore((s) => s.segmentCount)
  const error = useRadioBroadcastStore((s) => s.error)
  const nowPlayingText = useRadioBroadcastStore((s) => s.nowPlayingText)
  const startedAt = useRadioBroadcastStore((s) => s.startedAt)
  const maxRounds = useRadioBroadcastStore((s) => s.maxRounds)
  const maxSeconds = useRadioBroadcastStore((s) => s.maxSeconds)
  const stopReason = useRadioBroadcastStore((s) => s.stopReason)
  const transcript = useRadioBroadcastStore((s) => s.transcript)
  const sleepUntil = useRadioBroadcastStore((s) => s.sleepUntil)
  const sleepAfterSegment = useRadioBroadcastStore((s) => s.sleepAfterSegment)

  const start = useCallback((opts: Parameters<UseRadioBroadcastReturn['start']>[0]) => {
    return useRadioBroadcastStore.getState().start(opts)
  }, [])
  const stop = useCallback(() => {
    return useRadioBroadcastStore.getState().stop()
  }, [])
  const pause = useCallback(() => {
    useRadioBroadcastStore.getState().pause()
  }, [])
  const resume = useCallback(() => {
    useRadioBroadcastStore.getState().resume()
  }, [])
  const setRate = useCallback((rate: number) => {
    useRadioBroadcastStore.getState().setRate(rate)
  }, [])
  const sleep = useCallback((opts: { minutes?: number; afterSegment?: boolean } | null) => {
    useRadioBroadcastStore.getState().sleep(opts)
  }, [])
  const playLibraryItem = useCallback((item: LibraryItem) => {
    return useRadioBroadcastStore.getState().playLibraryItem(item)
  }, [])

  return {
    status,
    direction,
    voice,
    segment,
    segmentCount,
    error,
    nowPlayingText,
    startedAt,
    maxRounds,
    maxSeconds,
    stopReason,
    transcript,
    sleepUntil,
    sleepAfterSegment,
    isPlaying: status === 'playing',
    isActive: status === 'starting' || status === 'playing' || status === 'generating' || status === 'stopping',
    start,
    stop,
    pause,
    resume,
    setRate,
    sleep,
    playLibraryItem,
    directionPresets: DIRECTION_PRESETS,
    voices: MIMO_VOICES,
  }
}