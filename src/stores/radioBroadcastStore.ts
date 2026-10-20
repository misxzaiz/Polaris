/**
 * radioBroadcastStore — AI 连续语音播报的 UI 状态（Zustand）
 *
 * 职责：把控制器（services/voiceBroadcast/radioBroadcastController）的状态机
 * 快照投影到 React 可订阅的 store，并暴露 start/stop/pause/resume action。
 *
 * 所有权（对齐 spec §2.1）：控制器是状态机唯一写入方；本 store 只做只读投影 +
 * action 转发，不另写状态。
 */
import { create } from 'zustand'
import { radioBroadcastController } from '@/services/voiceBroadcast/radioBroadcastController'
import type {
  RadioBroadcastDirection,
  RadioBroadcastSnapshot,
  VoiceId,
} from '@/services/voiceBroadcast/types'

export interface RadioBroadcastStoreState extends RadioBroadcastSnapshot {
  /** 开始播报（异步；Promise 在首音频就绪或失败时 resolve） */
  start: (opts: {
    direction: RadioBroadcastDirection
    voice: VoiceId
    style?: string
    base64Mode?: boolean
    voiceStopEnabled?: boolean
    volume?: number
  }) => Promise<void>
  /** 停止播报（三路中断，幂等） */
  stop: () => Promise<void>
  /** 播放暂停（AI 保持生成） */
  pause: () => void
  /** 恢复播放 */
  resume: () => void
}

const EMPTY_SNAPSHOT: RadioBroadcastSnapshot = {
  status: 'idle',
  direction: { kind: 'custom', text: '' },
  voice: '冰糖',
  segment: null,
  segmentCount: 0,
  error: null,
  nowPlayingText: null,
}

export const useRadioBroadcastStore = create<RadioBroadcastStoreState>()(() => ({
  ...EMPTY_SNAPSHOT,

  start: async (opts) => {
    await radioBroadcastController.start(opts)
  },
  stop: async () => {
    await radioBroadcastController.stop()
  },
  pause: () => {
    radioBroadcastController.pause()
  },
  resume: () => {
    radioBroadcastController.resume()
  },
}))

// 控制器快照 → 本地状态投影（模块级订阅，create 之后建立一次）。
// 注意：控制器 subscribe() 会同步回调一次当前快照，因此必须在 create() 完成
// 之后订阅，否则回调里访问 useRadioBroadcastStore 会命中 TDZ
// （Cannot access before initialization）。
radioBroadcastController.subscribe((snapshot) => {
  useRadioBroadcastStore.setState(snapshot)
})
