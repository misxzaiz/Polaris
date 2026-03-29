/**
 * 聊天输入状态管理
 *
 * 用于在 ChatInput 和 ChatStatusBar 之间共享状态
 */

import { create } from 'zustand';
import type { VoiceCommand } from '../types/speech';

type SuggestionMode = 'workspace' | 'file' | 'git' | null;

interface ChatInputState {
  /** 当前输入字数 */
  inputLength: number;
  /** 附件数量 */
  attachmentCount: number;
  /** 当前建议模式 */
  suggestionMode: SuggestionMode;
  /** 是否有待回答的问题 */
  hasPendingQuestion: boolean;
  /** 是否有活跃的计划 */
  hasActivePlan: boolean;
  /** 待追加的语音文字 */
  speechTranscript: string;
  /** 上一次的语音文字（用于撤回） */
  previousTranscript: string;
  /** 待执行的语音命令 */
  speechCommand: VoiceCommand | null;

  /** 设置输入字数 */
  setInputLength: (length: number) => void;
  /** 设置附件数量 */
  setAttachmentCount: (count: number) => void;
  /** 设置建议模式 */
  setSuggestionMode: (mode: SuggestionMode) => void;
  /** 设置待回答问题状态 */
  setHasPendingQuestion: (has: boolean) => void;
  /** 设置活跃计划状态 */
  setHasActivePlan: (has: boolean) => void;
  /** 追加语音文字 */
  appendSpeechTranscript: (text: string) => void;
  /** 设置语音命令 */
  setSpeechCommand: (command: VoiceCommand | null) => void;
  /** 清空语音文字 */
  clearSpeechTranscript: () => void;
  /** 撤回最后一次语音输入 */
  undoSpeechTranscript: () => void;
}

export const useChatInputStore = create<ChatInputState>((set) => ({
  inputLength: 0,
  attachmentCount: 0,
  suggestionMode: null,
  hasPendingQuestion: false,
  hasActivePlan: false,
  speechTranscript: '',
  previousTranscript: '',
  speechCommand: null,

  setInputLength: (length) => set({ inputLength: length }),
  setAttachmentCount: (count) => set({ attachmentCount: count }),
  setSuggestionMode: (mode) => set({ suggestionMode: mode }),
  setHasPendingQuestion: (has) => set({ hasPendingQuestion: has }),
  setHasActivePlan: (has) => set({ hasActivePlan: has }),
  appendSpeechTranscript: (text) => set((state) => ({
    previousTranscript: state.speechTranscript,
    speechTranscript: state.speechTranscript + text
  })),
  setSpeechCommand: (command) => set({ speechCommand: command }),
  clearSpeechTranscript: () => set({ speechTranscript: '', previousTranscript: '' }),
  undoSpeechTranscript: () => set((state) => ({
    speechTranscript: state.previousTranscript,
    previousTranscript: ''
  })),
}));
