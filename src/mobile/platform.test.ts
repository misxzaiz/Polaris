import { describe, expect, it, vi } from 'vitest';
import { isMobileTauriRuntime, shouldRenderMobileApp } from './platform';

describe('mobile platform detection', () => {
  it('does not render mobile app for desktop browsers', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Windows');
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

    expect(isMobileTauriRuntime()).toBe(false);
    expect(shouldRenderMobileApp()).toBe(false);
  });

  it('renders mobile app only for mobile Tauri runtime', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Android');
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    expect(isMobileTauriRuntime()).toBe(true);
    expect(shouldRenderMobileApp()).toBe(true);

    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});
