/**
 * 环境检测 — 判断当前运行在 Tauri 桌面端还是浏览器 Web 端
 */

import type { TransportMode } from './types';

function isTestEnv(): boolean {
  try {
    // Vite/Vitest inject import.meta.env.MODE === 'test'
    return (import.meta as unknown as { env?: { MODE?: string } })?.env?.MODE === 'test';
  } catch {
    return false;
  }
}

/**
 * 检测当前传输模式
 *
 * Tauri 注入 `window.__TAURI_INTERNALS__`，有此标记即为桌面端，否则为 HTTP 模式。
 * 在单元测试环境中默认走 tauri transport，避免意外发起真实 HTTP 请求。
 */
export function detectTransport(): TransportMode {
  if (isTestEnv()) return 'tauri';

  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    ? 'tauri'
    : 'http';
}
