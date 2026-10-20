/**
 * radioBroadcastPrefsStore — AI 连续语音播报的面板配置偏好（持久化到 localStorage）
 *
 * 职责：面板配置（方向 kind/text、音色、音量、开关项、引擎/profile/model、轮次/时长）
 * 持久化。重开面板恢复上次配置，避免默认值重置。
 *
 * 所有权：仅本 store 写入/读取；控制器/useRadioBroadcastStore 不依赖本 store。
 * 面板 start() 时把 prefs 传入 start opts。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DirectionKind, VoiceId } from '@/services/voiceBroadcast/types'
import type { SessionRuntimeConfig } from '@/types/sessionConfig'

export interface RadioBroadcastPrefs {
  /** 方向 key */
  kind: DirectionKind
  /** 方向自由文本 */
  directionText: string
  /** 音色 */
  voice: VoiceId
  /** 音量（0~1） */
  volume: number
  /** 语音「停止」口令 */
  voiceStopEnabled: boolean
  /** 移动端 base64 模式 */
  base64Mode: boolean
  /** AI 引擎（空 = 跟随全局默认） */
  engineId: string
  /** 供应商/模型（面板选择，写回本地） */
  providerConfig: SessionRuntimeConfig
  /** 轮次上限（输入文本） */
  maxRounds: string
  /** 时长上限（输入文本） */
  maxSeconds: string

  setPrefs: (patch: Partial<RadioBroadcastPrefs>) => void
}

const DEFAULTS: Omit<RadioBroadcastPrefs, 'setPrefs'> = {
  kind: 'study',
  directionText: '经济学基础',
  voice: '冰糖',
  volume: 1,
  voiceStopEnabled: true,
  base64Mode: false,
  engineId: '',
  providerConfig: { profileMode: 'profile', modelProfileId: '', model: '' },
  maxRounds: '',
  maxSeconds: '',
}

export const useRadioBroadcastPrefsStore = create<RadioBroadcastPrefs>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setPrefs: (patch) => set(patch),
    }),
    {
      name: 'radio-broadcast-prefs',
      partialize: (state) => {
        // 只持久化配置，不持久化 action
        const { setPrefs: _setPrefs, ...rest } = state
        return rest
      },
    }
  )
)
