/**
 * 环境检测 — 判断当前运行在 Tauri 桌面端还是浏览器 Web 端
 */

import type { TransportMode } from './types';

/**
 * 检测当前传输模式
 *
 * Tauri 注入 `window.__TAURI_INTERNALS__`，有此标记即为桌面端，否则为 HTTP 模式。
 */
export function detectTransport(): TransportMode {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    ? 'tauri'
    : 'http';
}
