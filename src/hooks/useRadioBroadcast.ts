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

  start: (opts: RadioBroadcastControllerOptions) => Promise<void>
  stop: () => Promise<void>
  pause: () => void
  resume: () => void

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

  return {
    status,
    direction,
    voice,
    segment,
    segmentCount,
    error,
    nowPlayingText,
    isPlaying: status === 'playing',
    isActive: status === 'starting' || status === 'playing' || status === 'generating' || status === 'stopping',
    start,
    stop,
    pause,
    resume,
    directionPresets: DIRECTION_PRESETS,
    voices: MIMO_VOICES,
  }
}