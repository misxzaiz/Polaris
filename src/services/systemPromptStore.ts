/**
 * 系统提示词配置存储
 * 使用 localStorage 独立存储，不影响主配置
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { SystemPromptConfig, SystemPromptMode } from '@/types/config';

interface SystemPromptState {
  /** 当前配置 */
  config: SystemPromptConfig;
  /** 是否已完成水合（从 localStorage 恢复） */
  _hasHydrated: boolean;
  /** 设置水合状态 */
  setHasHydrated: (state: boolean) => void;
  /** 设置模式 */
  setMode: (mode: SystemPromptMode) => void;
  /** 设置自定义提示词 */
  setCustomPrompt: (prompt: string) => void;
  /** 设置启用状态 */
  setEnabled: (enabled: boolean) => void;
  /** 重置为默认配置 */
  reset: () => void;
}

/** 默认配置 */
const DEFAULT_CONFIG: SystemPromptConfig = {
  mode: 'append',
  customPrompt: '',
  enabled: false,
};

export const useSystemPromptStore = create<SystemPromptState>()(
  persist(
    (set) => ({
      config: DEFAULT_CONFIG,
      _hasHydrated: false,

      setHasHydrated: (state) => set({ _hasHydrated: state }),

      setMode: (mode) =>
        set((state) => ({
          config: { ...state.config, mode },
        })),

      setCustomPrompt: (customPrompt) =>
        set((state) => ({
          config: { ...state.config, customPrompt },
        })),

      setEnabled: (enabled) =>
        set((state) => ({
          config: { ...state.config, enabled },
        })),

      reset: () => set({ config: DEFAULT_CONFIG }),
    }),
    {
      name: 'polaris-system-prompt',
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);

/**
 * 直接从 localStorage 读取配置（同步，不依赖 Zustand 水合）
 * 用于在 store 未完成水合时获取配置
 */
export function getSystemPromptConfigDirect(): SystemPromptConfig {
  try {
    const stored = localStorage.getItem('polaris-system-prompt');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.state?.config) {
        return {
          mode: parsed.state.config.mode ?? 'default',
          customPrompt: parsed.state.config.customPrompt ?? '',
          enabled: parsed.state.config.enabled ?? false,
        };
      }
    }
  } catch {
    // ignore parsing errors
  }
  return DEFAULT_CONFIG;
}
