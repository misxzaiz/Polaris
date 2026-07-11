import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isDevMobileMode,
  isMobileTauriRuntime,
  shouldRenderMobileApp,
} from './platform';

describe('mobile platform detection', () => {
  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    // 清掉 ?mobile=1
    window.history.replaceState({}, '', window.location.pathname);
  });

  it('does not render mobile shell for desktop browsers', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Windows');
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

    expect(isMobileTauriRuntime()).toBe(false);
    expect(shouldRenderMobileApp()).toBe(false);
  });

  it('APK (mobile Tauri) uses full Web App by default, not MobileApp shell', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Android');
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    expect(isMobileTauriRuntime()).toBe(true);
    // 产品决策：默认复用 Web App
    expect(shouldRenderMobileApp()).toBe(false);
  });

  it('?mobile=1 forces legacy MobileApp shell for debugging', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Windows');
    window.history.replaceState({}, '', `${window.location.pathname}?mobile=1`);

    expect(isDevMobileMode()).toBe(true);
    expect(shouldRenderMobileApp()).toBe(true);
  });
});
