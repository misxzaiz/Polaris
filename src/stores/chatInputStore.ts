/**
 * 聊天输入状态管理
 *
 * 用于在 ChatInput 和 ChatStatusBar 之间共享状态
 */

import { create } from 'zustand';

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
}

export const useChatInputStore = create<ChatInputState>((set) => ({
  inputLength: 0,
  attachmentCount: 0,
  suggestionMode: null,
  hasPendingQuestion: false,
  hasActivePlan: false,

  setInputLength: (length) => set({ inputLength: length }),
  setAttachmentCount: (count) => set({ attachmentCount: count }),
  setSuggestionMode: (mode) => set({ suggestionMode: mode }),
  setHasPendingQuestion: (has) => set({ hasPendingQuestion: has }),
  setHasActivePlan: (has) => set({ hasActivePlan: has }),
}));
