/**
 * 主题状态管理
 *
 * 设计要点：
 * - `applyTheme(t)`：仅写 DOM (data-theme attribute) + localStorage + 内部 state，不触发服务端写。
 *   供 configStore 在 loadConfig/updateConfig 等同步流程中使用，避免循环更新。
 * - `setTheme(t)`：applyTheme + 服务端持久化（updateConfigPatch）。
 *   供 UI 主动切换（设置面板、ThemeSwitcher 按钮）调用。
 * - 启动时从 localStorage 读取初值；main.tsx 已在 React render 之前同步写 data-theme 防 FOUC。
 */

import { create } from 'zustand';
import { createLogger } from '@/utils/logger';

const log = createLogger('ThemeStore');

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'theme';
const DEFAULT_THEME: Theme = 'dark';

interface ThemeState {
  /** 当前主题 */
  theme: Theme;
  /** 应用主题：写 DOM + localStorage + 内部 state；不触发服务端写 */
  applyTheme: (theme: Theme) => void;
  /** 用户主动切换：applyTheme + 服务端持久化 */
  setTheme: (theme: Theme) => Promise<void>;
}

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'light' ? 'light' : 'dark';
}

function writeDom(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

function writeStorage(theme: Theme): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch (e) {
    log.warn('Failed to persist theme to localStorage', { error: e instanceof Error ? e.message : String(e) });
  }
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readInitialTheme(),

  applyTheme: (theme) => {
    if (get().theme === theme) {
      // 状态一致时仍补一次 DOM，保证 data-theme attr 与变量同步
      writeDom(theme);
      return;
    }
    writeDom(theme);
    writeStorage(theme);
    set({ theme });
  },

  setTheme: async (theme) => {
    writeDom(theme);
    writeStorage(theme);
    set({ theme });
    try {
      // 动态引入 configStore 避免循环依赖
      const { useConfigStore } = await import('./configStore');
      await useConfigStore.getState().updateConfigPatch({ theme });
    } catch (e) {
      log.error(
        'Failed to persist theme to server config',
        e instanceof Error ? e : new Error(String(e))
      );
    }
  },
}));
