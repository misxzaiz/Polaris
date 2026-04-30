import { describe, expect, it } from 'vitest';
import { MarkdownRenderCache } from './cache';

describe('MarkdownRenderCache', () => {
  it('keeps markdown images after sanitizing rendered html', () => {
    const cache = new MarkdownRenderCache();
    const html = cache.render('![puppy](data:image/png;base64,abc "dog")');

    expect(html).toContain('<img');
    expect(html).toContain('alt="puppy"');
    expect(html).toContain('title="dog"');
    expect(html).toContain('loading="lazy"');
  });
});
