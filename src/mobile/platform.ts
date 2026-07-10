export function isMobileUserAgent(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function isMobileTauriRuntime(): boolean {
  return isMobileUserAgent() &&
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in window;
}

export function shouldRenderMobileApp(): boolean {
  return isMobileTauriRuntime();
}
