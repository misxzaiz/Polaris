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
 * Tauri 注入 `window.__TAURI_INTERNALS__`，但仅凭这个判断不够：
 * Tauri Android 的 wry runtime 用 `addDocumentStartJavaScript(script, setOf("*"))`
 * 把初始化脚本注入到所有 origin，所以手机 App 跳转到远端 polaris-web 后
 * 全局对象仍然存在。此时必须走 HTTP 模式（fetch + Bearer token）。
 *
 * 桌面端 / 真本地 mobile shell 的 hostname：
 *   - "localhost"        (Linux/macOS: tauri://localhost)
 *   - "tauri.localhost"  (Windows/Android: http(s)://tauri.localhost)
 *   - ""                 (某些 scheme 下 hostname 可能为空)
 *
 * 远端加载后 hostname 是 IP 或自定义域名，必须走 HTTP。
 */
export function detectTransport(): TransportMode {
  if (isTestEnv()) return 'tauri';
  if (typeof window === 'undefined') return 'http';
  if (!('__TAURI_INTERNALS__' in window)) return 'http';

  const hostname = window.location.hostname;
  const isLocalHost =
    hostname === '' ||
    hostname === 'localhost' ||
    hostname === 'tauri.localhost';
  return isLocalHost ? 'tauri' : 'http';
}
