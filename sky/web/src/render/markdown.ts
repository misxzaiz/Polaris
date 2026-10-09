/** HTML 转义 + 简易 markdown(代码块/行内代码/粗体/链接/列表/换行) — 依赖 DOMPurify 净化 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

/** 渲染 markdown 文本为安全 HTML */
export function renderMarkdown(text: string): string {
  if (!text) return '';
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: ['p', 'br', 'b', 'strong', 'i', 'em', 'code', 'pre', 'span',
      'ul', 'ol', 'li', 'a', 'blockquote', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'del'],
    ALLOWED_ATTR: ['href', 'title', 'class'],
  });
}

/** 纯文本转义(用于非 markdown 场景) */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
