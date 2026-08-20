import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownRenderCache, setMarkdownArtifactBaseUrl } from './cache';

describe('MarkdownRenderCache', () => {
  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    setMarkdownArtifactBaseUrl(null);
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

  it('keeps Codex artifact image URLs in Tauri runtime when no artifact base URL is configured', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        convertFileSrc: () => {
          throw new Error('API artifact URLs must not be converted as local files');
        },
      },
    });

    const cache = new MarkdownRenderCache();
    const html = cache.render('![Codex image](/api/artifacts/codex-images/thread-1/ig_test.png)');

    expect(html).toContain('<img');
    expect(html).toContain('src="/api/artifacts/codex-images/thread-1/ig_test.png"');
    expect(html).toContain('alt="Codex image"');
  });

  it('uses the configured artifact base URL for Codex images in Tauri runtime', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        convertFileSrc: () => {
          throw new Error('API artifact URLs must not be converted as local files');
        },
      },
    });

    setMarkdownArtifactBaseUrl('http://localhost:9830/');

    const cache = new MarkdownRenderCache();
    const html = cache.render('![Codex image](/api/artifacts/codex-images/thread-1/ig_test.png)');

    expect(html).toContain(
      'src="http://localhost:9830/api/artifacts/codex-images/thread-1/ig_test.png"',
    );
  });

  it('rerenders cached Codex images when the artifact base URL changes', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        convertFileSrc: () => 'asset://local-file',
      },
    });

    const cache = new MarkdownRenderCache();
    const markdown = '![Codex image](/api/artifacts/codex-images/thread-1/ig_test.png)';

    setMarkdownArtifactBaseUrl('http://localhost:9830');
    expect(cache.render(markdown)).toContain(
      'src="http://localhost:9830/api/artifacts/codex-images/thread-1/ig_test.png"',
    );

    setMarkdownArtifactBaseUrl('http://localhost:9831');
    expect(cache.render(markdown)).toContain(
      'src="http://localhost:9831/api/artifacts/codex-images/thread-1/ig_test.png"',
    );
  });
});
