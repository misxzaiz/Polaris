/**
 * 通用缓存工具
 */

import { convertFileSrc } from '@tauri-apps/api/core';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { FileMatch } from '../services/fileSearch';
import { createLogger } from './logger';

const logger = createLogger('cache');

// 配置 marked
marked.setOptions({
  breaks: true,
  gfm: true,
});

// 自定义链接渲染：所有链接在新标签页打开，防止 SPA 页面跳转导致状态丢失
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

let markdownArtifactBaseUrl: string | null = null;
let markdownImageSrcConfigVersion = 0;

export function setMarkdownArtifactBaseUrl(baseUrl: string | null): void {
  const normalized = baseUrl?.trim().replace(/\/+$/, '') || null;
  if (normalized === markdownArtifactBaseUrl) return;

  markdownArtifactBaseUrl = normalized;
  markdownImageSrcConfigVersion += 1;
}

function isCodexArtifactApiReference(href: string): boolean {
  return href.startsWith('/api/artifacts/codex-images/');
}

function isLocalFileReference(href: string): boolean {
  if (href.startsWith('/api/')) {
    return false;
  }

  return /^[a-zA-Z]:[\\/]/.test(href) || href.startsWith('/') || href.startsWith('file://');
}

function normalizeMarkdownImageSrc(href: string): string {
  if (!href) return '';
  if (isTauriRuntime() && isCodexArtifactApiReference(href) && markdownArtifactBaseUrl) {
    return `${markdownArtifactBaseUrl}${href}`;
  }

  if (!isTauriRuntime() || !isLocalFileReference(href)) return href;

  const path = href.startsWith('file://') ? href.replace(/^file:\/\/\/?/, '') : href;
  return convertFileSrc(decodeURIComponent(path));
}

const linkRenderer = {
  link({ href, text }: { href: string; text: string }) {
    const safeHref = escapeHtmlAttribute(href);
    const safeText = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${safeText}</a>`;
  },
  image({ href, title, text }: { href: string; title: string | null; text: string }) {
    const safeSrc = escapeHtmlAttribute(normalizeMarkdownImageSrc(href));
    const safeAlt = escapeHtmlAttribute(text || '');
    const safeTitle = title ? ` title="${escapeHtmlAttribute(title)}"` : '';
    return `<img src="${safeSrc}" alt="${safeAlt}"${safeTitle} loading="lazy" />`;
  },
};
marked.use({ renderer: linkRenderer });

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

export class AsyncCache<T> {
  private cache: Map<string, CacheEntry<T>>;
  private ttl: number; // 缓存有效期（毫秒）

  constructor(ttl: number = 5000) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  /**
   * 获取缓存值
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  /**
   * 设置缓存值
   */
  set(key: string, value: T): void {
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  /**
   * 获取或计算缓存值
   */
  async getOrCompute(key: string, compute: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== null) {
      return cached;
    }

    const value = await compute();
    this.set(key, value);
    return value;
  }

  /**
   * 清除指定缓存
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * 清除所有缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 清除过期缓存
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * 获取缓存大小
   */
  get size(): number {
    return this.cache.size;
  }
}

/**
 * 同步缓存
 */
export class SyncCache<T> {
  private cache: Map<string, CacheEntry<T>>;
  private ttl: number;

  constructor(ttl: number = 5000) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  set(key: string, value: T): void {
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  getOrCompute(key: string, compute: () => T): T {
    const cached = this.get(key);
    if (cached !== null) {
      return cached;
    }

    const value = compute();
    this.set(key, value);
    return value;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * 带有最大缓存大小的 LRU 缓存
 */
export class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>>;
  private maxSize: number;
  private ttl: number;

  constructor(maxSize: number = 100, ttl: number = 5000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttl;
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    // 更新访问时间（移到最后）
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  set(key: string, value: T): void {
    // 如果已存在，先删除
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // 如果超过最大容量，删除最旧的（第一个）
    else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  get size(): number {
    return this.cache.size;
  }
}

// ============================================================================
// Markdown 渲染缓存
// ============================================================================

/**
 * Markdown 渲染缓存配置
 */
interface MarkdownCacheEntry {
  html: string;
  contentLength: number;
}

/**
 * 计算内容的简单哈希指纹
 * 用于快速比较内容是否变化
 *
 * 优化：使用更长的前缀和后缀来提高命中率准确性
 */
function getContentFingerprint(content: string): string {
  // 使用前 100 字符 + 后 50 字符 + 长度作为指纹
  // 这对增量更新的内容更有效，能更好地区分不同内容
  const len = content.length;
  const prefix = content.slice(0, 100);
  const suffix = len > 150 ? content.slice(-50) : '';
  return `${len}:${prefix.length}:${suffix.length}:${prefix.slice(-20)}${suffix.slice(0, 20)}`;
}

/**
 * Markdown 渲染缓存类
 *
 * 性能优化：
 * - 使用 LRU 缓存避免重复解析
 * - 增量内容检测：新内容是旧内容延伸时，只渲染新增部分
 * - 预设允许的 HTML 标签和属性
 */
/** 将 <table> 包裹在可横向滚动的容器中，防止宽表格撑开父布局 */
export function wrapTables(html: string): string {
  return html.replace(
    /(<table[\s>][\s\S]*?<\/table>)/g,
    '<div class="table-scroll-wrapper">$1</div>'
  );
}

/** 聊天消息 Markdown 渲染允许的 HTML 标签（含 GFM 任务列表 input） */
export const MARKDOWN_ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'span', 'div', 'mark', 'table', 'thead', 'tbody',
  'tr', 'td', 'th', 'hr', 'dl', 'dt', 'dd', 'input', 'img',
];

/** 聊天消息 Markdown 渲染允许的 HTML 属性 */
export const MARKDOWN_ALLOWED_ATTR = [
  'class',
  'href',
  'target',
  'rel',
  'type',
  'checked',
  'disabled',
  'src',
  'alt',
  'title',
  'loading',
];

export class MarkdownRenderCache {
  private cache: LRUCache<MarkdownCacheEntry>;
  private lastContent: string = '';
  private lastHtml: string = '';
  private lastRenderedLength: number = 0;
  private lastImageSrcConfigVersion: number = -1;

  private readonly ALLOWED_TAGS = MARKDOWN_ALLOWED_TAGS;
  private readonly ALLOWED_ATTR = MARKDOWN_ALLOWED_ATTR;

  constructor(maxSize: number = 100) {
    this.cache = new LRUCache<MarkdownCacheEntry>(maxSize, 60000); // 1 分钟 TTL
  }

  /**
   * 检测是否为增量追加（新内容以旧内容为前缀）
   */
  private isIncrementalAppend(newContent: string, oldContent: string): boolean {
    if (!oldContent) return false;
    if (newContent.length <= oldContent.length) return false;
    return newContent.startsWith(oldContent);
  }

  /**
   * 渲染 Markdown（带缓存 + 增量更新）
   *
   * 优化策略：
   * 1. 检查是否为增量更新（新内容是旧内容的延伸）
   * 2. 如果是增量，只渲染新增部分并追加
   * 3. 否则完整渲染
   */
  render(content: string): string {
    // 空内容快速返回
    if (!content) return '';

    const imageSrcConfigVersion = markdownImageSrcConfigVersion;

    // 如果内容没变，返回缓存的 HTML
    if (
      content === this.lastContent
      && this.lastHtml
      && imageSrcConfigVersion === this.lastImageSrcConfigVersion
    ) {
      return this.lastHtml;
    }

    // 检查缓存
    const fingerprint = `${imageSrcConfigVersion}:${getContentFingerprint(content)}`;
    const cached = this.cache.get(fingerprint);
    if (cached) {
      this.lastContent = content;
      this.lastHtml = cached.html;
      this.lastRenderedLength = content.length;
      this.lastImageSrcConfigVersion = imageSrcConfigVersion;
      return cached.html;
    }

    // 尝试增量渲染
    if (
      imageSrcConfigVersion === this.lastImageSrcConfigVersion
      && this.isIncrementalAppend(content, this.lastContent)
    ) {
      const incrementalHtml = this.renderIncremental(content, this.lastContent, this.lastHtml);
      if (incrementalHtml) {
        this.lastContent = content;
        this.lastHtml = incrementalHtml;
        this.lastRenderedLength = content.length;
        this.lastImageSrcConfigVersion = imageSrcConfigVersion;

        // 缓存结果
        this.cache.set(fingerprint, {
          html: incrementalHtml,
          contentLength: content.length,
        });

        return incrementalHtml;
      }
    }

    // 完整渲染
    try {
      const raw = marked.parse(content) as string;
      let html = DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: this.ALLOWED_TAGS,
        ALLOWED_ATTR: this.ALLOWED_ATTR,
      });
      html = wrapTables(html);

      // 缓存结果
      this.cache.set(fingerprint, {
        html,
        contentLength: content.length,
      });

      this.lastContent = content;
      this.lastHtml = html;
      this.lastRenderedLength = content.length;
      this.lastImageSrcConfigVersion = imageSrcConfigVersion;

      return html;
    } catch (error) {
      logger.error('Markdown 渲染错误:', error as Error);
      // 降级处理：转义 HTML
      return content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
    }
  }

  /**
   * 增量渲染：只渲染新增部分并合并
   *
   * 注意：增量渲染有局限性，对于跨块的内容（如代码块、表格）可能不准确
   * 因此只在满足特定条件时使用
   *
   * 优化：提高增量渲染阈值，减少完整渲染次数
   */
  private renderIncremental(
    newContent: string,
    oldContent: string,
    oldHtml: string
  ): string | null {
    const newPart = newContent.slice(oldContent.length);

    // 提高增量渲染阈值到 3000 字符（原来是 2000）
    // 流式输出时通常每次增量较小，这个阈值足够覆盖大多数情况
    if (newPart.length > 3000) {
      return null;
    }

    // 检查是否有未闭合的代码块
    const codeBlockCount = (oldContent.match(/```/g) || []).length;
    if (codeBlockCount % 2 !== 0) {
      // 有未闭合的代码块，不能增量渲染
      return null;
    }

    // 检查新增部分是否包含块级元素开始标记（可能跨块）
    if (/^(#{1,6}|[-*+]\s|>\s|```)/.test(newPart.trim())) {
      // 新增部分以块级元素开始，可能导致解析问题，完整渲染
      return null;
    }

    try {
      // 渲染新增部分
      const newRaw = marked.parse(newPart) as string;
      const newHtml = wrapTables(DOMPurify.sanitize(newRaw, {
        ALLOWED_TAGS: this.ALLOWED_TAGS,
        ALLOWED_ATTR: this.ALLOWED_ATTR,
      }));

      // 合并 HTML
      // 注意：这里简化处理，直接拼接。对于块级元素可能需要额外处理
      return oldHtml + newHtml;
    } catch {
      // 增量渲染失败，返回 null 表示需要完整渲染
      return null;
    }
  }

  /**
   * 预渲染内容（用于后台准备）
   */
  prerender(content: string): void {
    if (!content) return;
    this.render(content);
  }

  /**
   * 清除缓存
   */
  clear(): void {
    this.cache.clear();
    this.lastContent = '';
    this.lastHtml = '';
    this.lastRenderedLength = 0;
    this.lastImageSrcConfigVersion = -1;
  }

  /**
   * 获取缓存统计
   */
  get stats() {
    return {
      size: this.cache.size,
      lastContentLength: this.lastRenderedLength,
    };
  }
}

// 预定义的缓存实例
export const fileSearchCache = new AsyncCache<FileMatch[]>(5000);
export const commandCache = new SyncCache<unknown[]>(10000);

// 仅用于旧格式消息兼容路径，新格式走 ProgressiveStreamingMarkdown
export const markdownCache = new MarkdownRenderCache(20);
