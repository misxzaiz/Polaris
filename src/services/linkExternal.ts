/**
 * 外部链接点击统一分派（移动端防应用内跳转丢失状态）
 *
 * 背景：Android WebView（wry 单 Activity + 单 WebView）未 override onCreateWindow，
 * `window.open()` / `<a target="_blank">` 被降级为当前 WebView 同页导航 → 点击外链
 * 会整体替换 SPA JS 上下文，按返回键回到最后一次整页加载，表现为「应用被刷新/冷启」。
 *
 * 本模块是方案 B（plans/mobile-external-link-handling.md）的核心：
 * - 移动端（isMobileTauriRuntime）对一切「外部/新窗口」链接统一 preventDefault，
 *   交由 opener 插件 → 系统浏览器打开，当前 SPA 状态不被销毁。
 * - 桌面端 / 纯浏览器不注册全局 handler，行为零变更。
 *
 * shouldOpenExternal 用纯 URL 判定（不依赖 UA），便于单测与复用。
 */

import { isMobileTauriRuntime } from '@/mobile/platform';
import { openInBrowser } from '@/services/tauri/windowService';
import { createLogger } from '@/utils/logger';

const log = createLogger('linkExternal');

/** 声明为外部链接的标签选择器：`target="_blank"` 或 renderer 标记的 `data-open-external` */
export const EXTERNAL_LINK_SELECTOR = 'a[target="_blank"], a[data-open-external]';

/**
 * 不走「外部系统浏览器」的协议：这些交给应用本身/系统组件直接处理，
 * 外投反而会导航当前 SPA。mailto:/tel: 由系统弹对应意图。
 */
const NON_EXTERNAL_PROTOCOLS = new Set(['mailto:', 'tel:']);

/**
 * 判断一个 href 应否由「外部打开」处理。
 *
 * 返回 true（应外投到系统浏览器）：
 * - http: / https: 显式外链
 * 返回 false（保持应用内导航）：
 * - 空值、无协议（相对路径）、`#/...` 路由、`/api/` 静态资源、`/`、
 *   mailto:/tel:（系统能直接处理，避免 SPA 内错误导航）、
 *   file:、blob:、data:（本地资源，由各自入口负责，见 spec §五）
 *
 * 注意 blob/data URL 不在此外投：`ArtifactPreviewRenderer`、`UiFrameCard` 的
 * 「新窗口查看」有独立 open 分支处理 blob，全局捕获不误拦它们。
 */
export function shouldOpenExternal(href: string | undefined | null): boolean {
  if (!href) return false;
  const trimmed = href.trim();
  if (!trimmed) return false;

  // 无协议：相对路径、`#/` 路由、`/` 根路径 —— 应用内
  if (!/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(trimmed)) {
    return false;
  }

  const scheme = trimmed.split(':')[0].toLowerCase();
  if (NON_EXTERNAL_PROTOCOLS.has(scheme)) return false;

  // 应用自身静态资源/api，不视为外链
  if (scheme === 'http' || scheme === 'https') {
    // 明确排除同源的应用路由（相对路径已在上面无协议分支排除；这里防
    // 绝对地址指向应用自身 origin 时被外投——由调用方决定是否拦截，
    // 本函数对 http/https 一律视为外部）。
    return true;
  }

  return false;
}

/**
 * 打开外部链接：优先系统浏览器（opener 插件，移动端），失败兜底 window.open。
 *
 * 仅应在「已判定应外部打开」时调用（shouldOpenExternal 返回 true，或明确入口）。
 * 桌面端不经过全局 handler，但显式调用本函数时走 openInBrowser 仍安全（有 fallback）。
 */
export async function openExternalLink(href: string): Promise<void> {
  try {
    await openInBrowser(href);
  } catch (err) {
    log.warn('openExternalLink: opener 打开失败，兜底 window.open', {
      error: err instanceof Error ? err.message : String(err),
    });
    // window.open 兜底（Android 降级仍可能同页导航，属可接受的兜底，spec §八）
    window.open(href, '_blank', 'noopener,noreferrer');
  }
}

/**
 * 注册全局链接拦截（仅移动端起用）。返回取消函数。
 *
 * capture-phase 监听 document 层 click：命中 `target="_blank"` / `data-open-external`
 * 且 shouldOpenExternal 的 `<a>` → preventDefault + stopPropagation + openExternalLink。
 * 覆盖 `dangerouslySetInnerHTML` 注入的旧缓存 HTML、外部插件卡片的链接（不经 renderer）。
 *
 * 桌面端 / 纯浏览器不调用本函数（或调用后因 isMobileTauriRuntime()=false 直接返回），
 * 行为零变更。被拦截的应用内链接可加 `data-keep-in-app` 显式跳过。
 */
/**
 * 构造全局 click 拦截 handler（纯函数，便于单测）。
 * 命中 `target="_blank"` / `data-open-external` 且应外投的 `<a>` →
 * preventDefault + stopPropagation + openExternalLink。
 */
export function createExternalClickHandler(): (event: MouseEvent) => void {
  return (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;

    const anchor = target.closest<HTMLAnchorElement>(EXTERNAL_LINK_SELECTOR);
    if (!anchor) return;

    // 显式「留在应用内」标记跳过拦截
    if (anchor.hasAttribute('data-keep-in-app')) return;

    const href = anchor.getAttribute('href');
    if (!href || !shouldOpenExternal(href)) return;

    // 排除非普通左键（中键/修饰键保留系统语义）
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void openExternalLink(href);
  };
}

export function registerExternalLinkGlobalHandler(): () => void {
  if (!isMobileTauriRuntime()) {
    // 桌面/web：不注册监听，保持原生 target="_blank" 行为
    return () => {};
  }

  const handleClick = createExternalClickHandler();
  document.addEventListener('click', handleClick, true);
  return () => document.removeEventListener('click', handleClick, true);
}