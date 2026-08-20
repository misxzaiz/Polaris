/**
 * voiceCompanionStore - 语音伙伴状态管理
 *
 * 管理语音通话界面的开关、对话阶段状态机、实时字幕与配置。
 * 配置独立持久化于 localStorage，不进全局 Config（避免跨端 Rust 改动）。
 */

import { create } from 'zustand';
import type { VoicePhase, VoiceCompanionMode, VoiceCompanionConfig } from '@/types/voiceCompanion';
import { DEFAULT_VOICE_COMPANION_CONFIG, VOICE_COMPANION_CONFIG_KEY } from '@/types/voiceCompanion';
import { createLogger } from '@/utils/logger';

const log = createLogger('VoiceCompanionStore');

/** 从 localStorage 读取配置（带默认值合并 + 旧版本迁移） */
function loadConfig(): VoiceCompanionConfig {
  try {
    const raw = localStorage.getItem(VOICE_COMPANION_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VoiceCompanionConfig>;
      // 迁移 v2：默认唤醒词 ['小陈'] 升级为含同音容错的新默认列表
      if (
        parsed.wakeWord?.words?.length === 1 &&
        parsed.wakeWord.words[0] === '小陈'
      ) {
        parsed.wakeWord = {
          ...parsed.wakeWord,
          words: [...DEFAULT_VOICE_COMPANION_CONFIG.wakeWord.words],
        };
      }
      // 迁移 v4：autoSend 默认改为 false（旧默认 true 会误发）
      if (
        !parsed.configVersion ||
        parsed.configVersion < 4
      ) {
        parsed.autoSend = false;
      }
      return { ...DEFAULT_VOICE_COMPANION_CONFIG, ...parsed };
    }
  } catch (e) {
    log.warn('读取语音伙伴配置失败，使用默认配置', { error: String(e) });
  }
  return { ...DEFAULT_VOICE_COMPANION_CONFIG };
}

/** 持久化配置 */
function persistConfig(config: VoiceCompanionConfig): void {
  try {
    localStorage.setItem(VOICE_COMPANION_CONFIG_KEY, JSON.stringify(config));
  } catch (e) {
    log.warn('持久化语音伙伴配置失败', { error: String(e) });
  }
}

interface VoiceCompanionState {
  /** 通话界面是否打开 */
  isOpen: boolean;
  /** 当前对话阶段 */
  phase: VoicePhase;
  /** 配置 */
  config: VoiceCompanionConfig;
  /** 当前识别中的字幕（用户正在说的话） */
  transcript: string;
  /** 最近一次发送的用户语句 */
  lastUserText: string;
  /** 最近一次 AI 回复（用于字幕展示） */
  lastReply: string;
  /** 是否静音（暂停聆听） */
  muted: boolean;
  /** 错误信息 */
  errorMessage: string | null;
}

interface VoiceCompanionActions {
  open: () => void;
  close: () => void;
  toggle: () => void;
  setPhase: (phase: VoicePhase) => void;
  setTranscript: (transcript: string) => void;
  setLastUserText: (text: string) => void;
  setLastReply: (reply: string) => void;
  setMuted: (muted: boolean) => void;
  toggleMute: () => void;
  setMode: (mode: VoiceCompanionMode) => void;
  updateConfig: (updates: Partial<VoiceCompanionConfig>) => void;
  setError: (message: string | null) => void;
  reset: () => void;
}

export type VoiceCompanionStore = VoiceCompanionState & VoiceCompanionActions;

export const useVoiceCompanionStore = create<VoiceCompanionStore>((set, get) => ({
  // ===== 初始状态 =====
  isOpen: false,
  phase: 'idle',
  config: loadConfig(),
  transcript: '',
  lastUserText: '',
  lastReply: '',
  muted: false,
  errorMessage: null,

  // ===== Actions =====
  open: () => set({ isOpen: true, phase: 'idle', errorMessage: null, transcript: '' }),

  close: () => set({ isOpen: false, phase: 'idle', transcript: '', muted: false }),

  toggle: () => {
    if (get().isOpen) {
      get().close();
    } else {
      get().open();
    }
  },

  setPhase: (phase) => set({ phase }),
  setTranscript: (transcript) => set({ transcript }),
  setLastUserText: (lastUserText) => set({ lastUserText }),
  setLastReply: (lastReply) => set({ lastReply }),
  setMuted: (muted) => set({ muted }),
  toggleMute: () => set((s) => ({ muted: !s.muted })),

  setMode: (mode) => {
    const config = { ...get().config, mode };
    persistConfig(config);
    set({ config });
  },

  updateConfig: (updates) => {
    const config = { ...get().config, ...updates };
    persistConfig(config);
    set({ config });
  },

  setError: (errorMessage) =>
    set((s) => ({
      errorMessage,
      phase: errorMessage ? 'error' : s.phase,
    })),

  reset: () =>
    set({
      phase: 'idle',
      transcript: '',
      lastUserText: '',
      lastReply: '',
      errorMessage: null,
    }),
}));
