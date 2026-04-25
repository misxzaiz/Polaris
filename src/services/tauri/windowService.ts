/**
 * 窗口控制、翻译、系统相关 Tauri 命令
 */

import { invoke } from '@/services/transport';
import { createLogger } from '../../utils/logger';

const log = createLogger('WindowService');

// Detect Tauri environment
const isTauriEnv = typeof window !== 'undefined' && '__TAURI__' in window;

/** Lazy-loaded Tauri APIs */
let _openPath: ((path: string) => Promise<void>) | null = null;
let _getCurrentWindow: (() => { minimize: () => Promise<void>; maximize: () => Promise<void>; unmaximize: () => Promise<void>; isMaximized: () => Promise<boolean>; close: () => Promise<void> }) | null = null;

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
