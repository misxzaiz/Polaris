/**
 * 窗口控制、翻译、系统相关 Tauri 命令
 */

import { invoke } from '@/services/transport';
import { openPath } from '@tauri-apps/plugin-opener';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ============================================================================
// 系统相关命令
// ============================================================================

/** 在默认应用中打开文件（HTML 文件可在浏览器中打开） */
export async function openInDefaultApp(path: string): Promise<void> {
  await openPath(path);
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
  const window = getCurrentWindow();
  await window.minimize();
}

/** 最大化/还原窗口 */
export async function toggleMaximizeWindow(): Promise<void> {
  const window = getCurrentWindow();
  if (await window.isMaximized()) {
    await window.unmaximize();
  } else {
    await window.maximize();
  }
}

/** 关闭窗口 */
export async function closeWindow(): Promise<void> {
  const window = getCurrentWindow();
  await window.close();
}
