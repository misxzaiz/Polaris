import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectTransport, isEmbeddedBrowserWebview } from './detector';

interface TauriInternals {
  metadata?: { currentWebview?: { label?: string } };
}

function setInternals(value: TauriInternals | null) {
  const w = window as Window & { __TAURI_INTERNALS__?: TauriInternals };
  if (value === null) delete w.__TAURI_INTERNALS__;
  else w.__TAURI_INTERNALS__ = value;
}

function setHostname(hostname: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { hostname },
  });
}

describe('isEmbeddedBrowserWebview', () => {
  beforeEach(() => setInternals({ metadata: { currentWebview: { label: 'main' } } }));
  afterEach(() => setInternals(null));

  it('returns true when current webview label starts with browser-', () => {
    setInternals({ metadata: { currentWebview: { label: 'browser-abc-123' } } });
    expect(isEmbeddedBrowserWebview()).toBe(true);
  });

  it('returns false for main window webview', () => {
    setInternals({ metadata: { currentWebview: { label: 'main' } } });
    expect(isEmbeddedBrowserWebview()).toBe(false);
  });

  it('returns false when metadata or label is missing', () => {
    setInternals({});
    expect(isEmbeddedBrowserWebview()).toBe(false);
    setInternals({ metadata: {} });
    expect(isEmbeddedBrowserWebview()).toBe(false);
    setInternals({ metadata: { currentWebview: {} } });
    expect(isEmbeddedBrowserWebview()).toBe(false);
  });

  it('returns false when __TAURI_INTERNALS__ absent', () => {
    setInternals(null);
    expect(isEmbeddedBrowserWebview()).toBe(false);
  });
});

describe('detectTransport — embedded browser webview (the bug this fixes)', () => {
  beforeEach(() => {
    // 素 jsdom：无 __TAURI_INTERNALS__，VITE_FORCE_HTTP 未定义，hostname localhost
    setInternals(null);
    setHostname('localhost');
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setInternals(null);
  });

  it('plain browser (no __TAURI_INTERNALS__) routes to http', () => {
    expect(detectTransport()).toBe('http');
  });

  it('embedded browser (browser-* webview) on localhost routes to http, not tauri IPC', () => {
    setInternals({ metadata: { currentWebview: { label: 'browser-browser-1789141053463-7jxxitu' } } });
    expect(detectTransport()).toBe('http');
  });

  it('main window webview on localhost still routes to tauri IPC', () => {
    setInternals({ metadata: { currentWebview: { label: 'main' } } });
    expect(detectTransport()).toBe('tauri');
  });

  it('tauri main webview on non-localhost routes to http', () => {
    setInternals({ metadata: { currentWebview: { label: 'main' } } });
    setHostname('example.com');
    expect(detectTransport()).toBe('http');
  });
});