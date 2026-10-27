import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderCache } from './cache';

describe('MarkdownRenderCache', () => {
  const originalIsMobile = (globalThis as any).__isMobileTauriRuntimeForTest;

  beforeEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    if (originalIsMobile === undefined) {
      delete (globalThis as any).__isMobileTauriRuntimeForTest;
    } else {
      (globalThis as any).__isMobileTauriRuntimeForTest = originalIsMobile;
    }
  });

  it('keeps markdown images after sanitizing rendered html', () => {
    const cache = new MarkdownRenderCache();
    const html = cache.render('![puppy](data:image/png;base64,abc "dog")');

    expect(html).toContain('<img');
    expect(html).toContain('class="markdown-chat-image"');
    expect(html).toContain('alt="puppy"');
    expect(html).toContain('title="dog"');
    expect(html).toContain('loading="lazy"');
  });

  it('desktop: renderer does NOT emit data-open-external', () => {
    (window as any).__TAURI_INTERNALS__ = {};
    const cache = new MarkdownRenderCache();
    const html = cache.render('[link](https://example.com)');
    expect(html).toContain('href="https://example.com');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('data-open-external');
  });

  it('mobile: renderer emits data-open-external for links', () => {
    // 设置移动端 Tauri 运行时环境
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      writable: true,
      configurable: true,
    });
    // 覆盖 navigator.userAgent 模拟 Android
    const originalUA = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
      writable: false,
      configurable: true,
    });
    try {
      const cache = new MarkdownRenderCache();
      const html = cache.render('[link](https://example.com)');
      expect(html).toContain('data-open-external="1"');
      expect(html).toContain('target="_blank"');
    } finally {
      if (originalUA) {
        Object.defineProperty(navigator, 'userAgent', originalUA);
      } else {
        delete (navigator as any).userAgent;
      }
    }
  });
});
