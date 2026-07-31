/**
 * 语音输入 & 输入框 UI 状态管理
 *
 * 从旧 sessionStore 拆分出的独立 Store，仅管理语音识别和输入相关的 UI 状态。
 * 会话管理已由 conversationStore 替代。
 */

import { create } from 'zustand'
import type { VoiceCommand } from '@/types/speech'

interface VoiceInputState {
  /** 语音识别文字 */
  speechTranscript: string
  /** 上一次语音识别文字（用于撤回） */
  previousTranscript: string
  /** 待执行的语音命令 */
  speechCommand: VoiceCommand | null
  /** 语音唤醒状态 */
  speechWakeActive: boolean

  /** 当前输入字数 */
  inputLength: number
  /** 附件数量 */
  attachmentCount: number
  /** 建议模式 */
  suggestionMode: 'workspace' | 'file' | null

  // Actions
  setInputLength: (length: number) => void
  setAttachmentCount: (count: number) => void
  setSuggestionMode: (mode: 'workspace' | 'file' | null) => void
  appendSpeechTranscript: (text: string) => void
  clearSpeechTranscript: () => void
  undoSpeechTranscript: () => void
  setSpeechCommand: (command: VoiceCommand | null) => void
  setSpeechWakeActive: (active: boolean) => void
}

export const useVoiceInputStore = create<VoiceInputState>()((set, get) => ({
  speechTranscript: '',
  previousTranscript: '',
  speechCommand: null,
  speechWakeActive: false,
  inputLength: 0,
  attachmentCount: 0,
  suggestionMode: null,

  setInputLength: (length) => set({ inputLength: length }),
  setAttachmentCount: (count) => set({ attachmentCount: count }),
  setSuggestionMode: (mode) => set({ suggestionMode: mode }),

  appendSpeechTranscript: (text) => {
    const { speechTranscript } = get()
    set({ previousTranscript: speechTranscript, speechTranscript: speechTranscript + text })
  },

  clearSpeechTranscript: () => set({ speechTranscript: '', previousTranscript: '' }),

  undoSpeechTranscript: () => {
    const { previousTranscript } = get()
    set({ speechTranscript: previousTranscript, previousTranscript: '' })
  },

  setSpeechCommand: (command) => set({ speechCommand: command }),

  setSpeechWakeActive: (active) => set({ speechWakeActive: active }),
}))