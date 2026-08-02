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
import { syncSpiderManCssVarsToDom } from '@/utils/spiderman-theme';

const log = createLogger('ThemeStore');

export type Theme = 'dark' | 'light' | 'spiderman';

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
  if (stored === 'spiderman') return 'spiderman';
  return stored === 'light' ? 'light' : 'dark';
}

/** 同步 Spider-Man CSS 变量到 DOM（委托给共享工具函数） */
function syncSpiderManCssVars(): void {
  syncSpiderManCssVarsToDom();
}

function writeDom(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  // 同步更新 favicon
  const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
  if (link) {
    link.href = theme === 'spiderman' ? '/spiderman-favicon.svg' : '/tauri.svg';
  }
  // 同步 Spider-Man CSS 变量
  if (theme === 'spiderman') {
    syncSpiderManCssVars();
  }
}

function writeStorage(theme: Theme): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch (e) {
    log.warn('Failed to persist theme to localStorage', { error: e instanceof Error ? e.message : String(e) });
  }
}

// 启动时同步 Spider-Man CSS 变量（如果主题是 spiderman）
// 注意：main.tsx 内联脚本已在 React render 之前同步过一次，
// 此处作为兜底确保 themeStore 初始化后 CSS 变量与 state 一致。
const initialTheme = readInitialTheme();
if (initialTheme === 'spiderman' && typeof window !== 'undefined') {
  // 使用 requestAnimationFrame 替代 queueMicrotask，
  // 确保在首次 paint 之后执行，避免与 main.tsx 的内联脚本竞争。
  requestAnimationFrame(() => syncSpiderManCssVars());
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initialTheme,

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
