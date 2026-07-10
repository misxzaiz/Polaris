export function isMobileUserAgent(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function isMobileTauriRuntime(): boolean {
  return isMobileUserAgent() &&
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in window;
}

/**
 * 开发用移动端模拟开关：
 * 浏览器访问 http://localhost:1420?mobile=1 即可在桌面浏览器渲染移动端 UI。
 */
export function isDevMobileMode(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('mobile') === '1';
}

export function shouldRenderMobileApp(): boolean {
  return isMobileTauriRuntime() || isDevMobileMode();
}
