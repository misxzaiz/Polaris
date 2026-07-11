/**
 * 移动端入口判定
 *
 * 产品决策（2026-07-12）：
 * APK / 手机浏览器默认复用完整 Web `App`（小屏 compact 体验已验证良好），
 * 不再默认进入独立 MobileApp companion 壳。
 *
 * - isMobileTauriRuntime：用于连接配置持久化、HTTP transport 等
 * - shouldRenderMobileApp：仅开发调试旧壳时使用（?mobile=1）
 */

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
 * 开发用：强制渲染旧 MobileApp 壳。
 * 浏览器访问 ?mobile=1 可预览 companion UI（非默认产品路径）。
 */
export function isDevMobileMode(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('mobile') === '1';
}

/**
 * 是否渲染独立 MobileApp。
 * 默认 false：APK 与手机浏览器均走完整 Web App。
 * 仅 ?mobile=1 时为 true（调试旧壳）。
 */
export function shouldRenderMobileApp(): boolean {
  return isDevMobileMode();
}
