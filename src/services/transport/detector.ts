/**
 * 环境检测 — 判断当前运行在 Tauri 桌面端还是浏览器 Web 端
 */

import type { TransportMode } from './types';

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
 * 检测当前是否运行在 Polaris 内置浏览器的动态 webview 中。
 *
 * 内置浏览器（BrowserPanel）由 Rust 后端用 `browser_acquire` 创建动态 webview，
 * label 恒为 `browser-<tabId>`（见 src/services/tauri/browserService.ts
 * makeBrowserWebviewLabel）。该 webview 里加载的可能是任意远程页面，
 * 主旨等同"普通浏览器"——不应暴露 Tauri IPC 能力，应走 HTTP 传输。
 * 主窗口 webview label 固定为 "main"（tauri.conf.json 主窗口配置）。
 *
 * 读取 __TAURI_INTERNALS__.metadata.currentWebview.label 是 Tauri v2
 * 官方暴露的运行时信息，无需额外 IPC，稳定可靠。
 */
export function isEmbeddedBrowserWebview(): boolean {
  if (typeof window === 'undefined') return false;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWebview?: { label?: string } } } })
    .__TAURI_INTERNALS__;
  const label = internals?.metadata?.currentWebview?.label;
  return typeof label === 'string' && label.startsWith('browser-');
}

/**
 * 检测当前传输模式
 *
 * 桌面端 Tauri 使用 IPC 直连（hostname = localhost / tauri.localhost）。
 * 移动端 Tauri WebView 内嵌前端，同样走 HTTP + WebSocket。
 * 浏览器直接访问 polaris-web 也走 HTTP。
 */
export function detectTransport(): TransportMode {
  if (typeof window === 'undefined') return 'http';

  // 移动端始终走 HTTP 模式（内嵌前端 + 本地 HTTP 服务）
  if (isMobilePlatform()) return 'http';

  // Dev-only: 显式强制 HTTP（AI 自动测试用）。
  // import.meta.env.DEV 仅 vite dev 为 true；生产构建 DEV=false 且 VITE_FORCE_HTTP
  // 未定义，此分支恒为 false，线上 web 行为完全不变。
  if (import.meta.env.DEV && import.meta.env.VITE_FORCE_HTTP === '1') return 'http';

  if (!('__TAURI_INTERNALS__' in window)) return 'http';

  // 内置浏览器动态 webview（label: browser-*）等同普通浏览器，走 HTTP 而非 IPC。
  // 否则其页面会误判为 tauri 模式 → 所有命令走 IPC → 被 ACL 白名单拒绝。
  if (isEmbeddedBrowserWebview()) return 'http';

  const hostname = window.location.hostname;
  const isLocalHost =
    hostname === '' ||
    hostname === 'localhost' ||
    hostname === 'tauri.localhost';
  return isLocalHost ? 'tauri' : 'http';
}
