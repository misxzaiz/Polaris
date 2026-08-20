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
 * 检测是否为移动平台（Android / iOS）
 *
 * 移动端 Tauri WebView 内嵌完整前端，通过本地 HTTP 服务器提供 API，
 * 必须走 HTTP 模式而非 Tauri IPC。
 */
function isMobilePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod/i.test(ua);
}

/**
 * 检测当前传输模式
 *
 * 桌面端 Tauri 使用 IPC 直连（hostname = localhost / tauri.localhost）。
 * 移动端 Tauri WebView 内嵌前端，同样走 HTTP + WebSocket。
 * 浏览器直接访问 polaris-web 也走 HTTP。
 */
export function detectTransport(): TransportMode {
  if (isTestEnv()) return 'tauri';
  if (typeof window === 'undefined') return 'http';

  // 移动端始终走 HTTP 模式（内嵌前端 + 本地 HTTP 服务）
  if (isMobilePlatform()) return 'http';

  if (!('__TAURI_INTERNALS__' in window)) return 'http';

  const hostname = window.location.hostname;
  const isLocalHost =
    hostname === '' ||
    hostname === 'localhost' ||
    hostname === 'tauri.localhost';
  return isLocalHost ? 'tauri' : 'http';
}
