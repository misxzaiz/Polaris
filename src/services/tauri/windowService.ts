/**
 * 窗口控制、翻译、系统相关 Tauri 命令
 */

import { invoke } from '@/services/transport';
import { createLogger } from '@/utils/logger';

const log = createLogger('WindowService');

// Detect Tauri environment
const isTauriEnv = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Lazy-loaded Tauri APIs */
let _openPath: ((path: string) => Promise<void>) | null = null;
let _openUrl: ((url: string) => Promise<void>) | null = null;
let _getCurrentWindow: (() => { minimize: () => Promise<void>; maximize: () => Promise<void>; unmaximize: () => Promise<void>; isMaximized: () => Promise<boolean>; setFullscreen: (fullscreen: boolean) => Promise<void>; isFullscreen: () => Promise<boolean>; onResized: (handler: () => void) => Promise<() => void>; close: () => Promise<void> }) | null = null;

async function getOpenPath() {
  if (!isTauriEnv) return null;
  if (!_openPath) {
    try {
      const mod = await import('@tauri-apps/plugin-opener');
      _openPath = mod.openPath;
    } catch {
      log.warn('Failed to load @tauri-apps/plugin-opener');
      return null;
    }
  }
  return _openPath;
}

async function getOpenUrl() {
  if (!isTauriEnv) return null;
  if (!_openUrl) {
    try {
      const mod = await import('@tauri-apps/plugin-opener');
      _openUrl = mod.openUrl;
    } catch {
      log.warn('Failed to load @tauri-apps/plugin-opener');
      return null;
    }
  }
  return _openUrl;
}

async function getGetCurrentWindow() {
  if (!isTauriEnv) return null;
  if (!_getCurrentWindow) {
    try {
      const mod = await import('@tauri-apps/api/window');
      _getCurrentWindow = mod.getCurrentWindow;
    } catch {
      log.warn('Failed to load @tauri-apps/api/window');
      return null;
    }
  }
  return _getCurrentWindow;
}

// ============================================================================
// 系统相关命令
// ============================================================================

/** 在默认应用中打开文件（HTML 文件可在浏览器中打开） */
export async function openInDefaultApp(path: string): Promise<void> {
  const openPathFn = await getOpenPath();
  if (openPathFn) {
    await openPathFn(path);
  } else {
    // Web fallback: open in new tab
    window.open(path, '_blank');
  }
}

export async function openInBrowser(url: string): Promise<void> {
  const openUrlFn = await getOpenUrl();
  if (openUrlFn) {
    await openUrlFn(url);
  } else {
    window.open(url, '_blank');
  }
}

// ============================================================================
// 翻译相关命令
// ============================================================================

/** 翻译结果 */
export interface TranslateResult {
  success: boolean;
  result?: string;
  error?: string;
}

/** 百度翻译 */
export async function baiduTranslate(
  text: string,
  appId: string,
  secretKey: string,
  to?: string
): Promise<TranslateResult> {
  return invoke<TranslateResult>('baidu_translate', { text, appId, secretKey, to });
}

// ============================================================================
// 窗口控制相关命令
// ============================================================================

/** 设置/退出全屏 */
export async function setFullscreen(fullscreen: boolean): Promise<void> {
  const getWindow = await getGetCurrentWindow();
  if (getWindow) {
    const window = getWindow();
    await window.setFullscreen(fullscreen);
  }
}

/** 检查当前是否全屏状态 */
export async function isFullscreen(): Promise<boolean> {
  const getWindow = await getGetCurrentWindow();
  if (getWindow) {
    const window = getWindow();
    return window.isFullscreen();
  }
  return false;
}

/**
 * 监听全屏状态变化。
 *
 * Tauri 模式下窗口级的 setFullscreen 不会触发 DOM 的 fullscreenchange 事件，
 * 因此通过 onResized（窗口大小变化时触发）内部调用 isFullscreen() 检测。
 *
 * 返回取消监听的函数；非 Tauri 环境返回 null。
 */
export async function onFullscreenChange(
  callback: (isFullscreen: boolean) => void
): Promise<(() => void) | null> {
  const getWindow = await getGetCurrentWindow();
  if (!getWindow) return null;
  const win = getWindow();
  const unlisten = await win.onResized(async () => {
    try {
      const fs = await win.isFullscreen();
      callback(fs);
    } catch {
      // 静默失败
    }
  });
  return unlisten;
}

/** 最小化窗口 */
export async function minimizeWindow(): Promise<void> {
  const getWindow = await getGetCurrentWindow();
  if (getWindow) {
    const window = getWindow();
    await window.minimize();
  }
}

/** 最大化/还原窗口 */
export async function toggleMaximizeWindow(): Promise<void> {
  const getWindow = await getGetCurrentWindow();
  if (getWindow) {
    const window = getWindow();
    if (await window.isMaximized()) {
      await window.unmaximize();
    } else {
      await window.maximize();
    }
  }
}

/** 关闭窗口 */
export async function closeWindow(): Promise<void> {
  const getWindow = await getGetCurrentWindow();
  if (getWindow) {
    const window = getWindow();
    await window.close();
  }
}
