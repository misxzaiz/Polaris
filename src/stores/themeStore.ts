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

/** Spider-Man 主题默认背景图 */
const SPIDERMAN_DEFAULT_BG = 'https://images.unsplash.com/photo-1534809027769-b00d750a6bac?q=80&w=1920';

/** 同步 Spider-Man CSS 变量到 DOM */
function syncSpiderManCssVars(): void {
  if (typeof document === 'undefined') return;
  try {
    const stored = window.localStorage.getItem('spiderman-theme');
    const config = stored ? JSON.parse(stored) : {};
    // 明确检查用户是否选择了「关闭背景」（backgroundImage === ''）
    const bgOff = 'backgroundImage' in config && !config.backgroundImage;
    const bg = bgOff ? '' : (config.backgroundImage || SPIDERMAN_DEFAULT_BG);
    if (bgOff || !bg) {
      document.documentElement.setAttribute('data-spiderman-bg-off', '');
    } else {
      document.documentElement.style.setProperty('--spiderman-bg-image', `url('${bg}')`);
      document.documentElement.removeAttribute('data-spiderman-bg-off');
    }
    // 计算遮罩 alpha = 1 - bgOpacity，写入 --spiderman-bg-overlay
    const bgOpacity = config.backgroundOpacity ?? 0.2;
    const overlayAlpha = Math.max(0, Math.min(1, 1 - bgOpacity));
    document.documentElement.style.setProperty('--spiderman-bg-overlay', String(overlayAlpha));
    document.documentElement.style.setProperty('--spiderman-web-opacity', String(config.webTextureOpacity ?? 0.15));
    document.documentElement.style.setProperty('--spiderman-bg-position',
      `${config.backgroundPositionX ?? 50}% ${config.backgroundPositionY ?? 50}%`);
    document.documentElement.style.setProperty('--spiderman-bg-size', config.backgroundSize ?? 'cover');
    // 同步面具头像 URL
    if (config.avatarUrl) {
      document.documentElement.style.setProperty('--spiderman-avatar-url', `url('${config.avatarUrl}')`);
    } else {
      document.documentElement.style.removeProperty('--spiderman-avatar-url');
    }
  } catch {
    // 静默失败，使用 CSS 默认值
  }
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
const initialTheme = readInitialTheme();
if (initialTheme === 'spiderman') {
  // 延迟到 DOM 就绪后执行
  if (typeof window !== 'undefined') {
    queueMicrotask(() => syncSpiderManCssVars());
  }
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
