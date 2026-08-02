/**
 * 移动端入口判定
 *
 * APK / 手机浏览器默认复用完整 Web App（小屏 compact 体验已验证良好）。
 * 旧版独立 MobileApp companion 壳已废弃（2026-07-12 产品决策）。
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

/** 检测当前环境是否支持二维码扫描（需要 getUserMedia） */
export function supportsQrScanning(): boolean {
  return !!(
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}