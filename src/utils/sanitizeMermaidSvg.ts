/**
 * Mermaid SVG 轻量级安全清理
 *
 * Mermaid.js 的 SVG 输出是可信来源，但需要防范恶意图表代码注入（如 <script>、事件处理器）。
 * 不使用 DOMPurify，因为它无法同时保留 SVG <style> 元素和 <foreignObject> 内的 HTML 内容，
 * 而 Mermaid 11.x 的文字渲染依赖这两者。
 */

/** 需要移除的危险元素标签 */
const DANGEROUS_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'applet',
  'form',
  'base',
  'meta',
  'link',
]);

/** 需要移除的事件处理器属性（on* 前缀） */
const DANGEROUS_ATTR_PATTERN = /^on[a-z]/i;

/** 危险的 URL 协议 */
const DANGEROUS_PROTOCOLS = /^\s*(javascript|vbscript|data|blob):/i;

/** 允许的 URL 协议 */
const SAFE_PROTOCOLS = /^\s*(https?|mailto|tel|#|\/)/i;

/**
 * 清理 Mermaid 生成的 SVG 字符串
 *
 * 移除：
 * - 危险元素：script, iframe, object, embed 等
 * - 事件处理器属性：onclick, onload, onerror 等
 * - 危险 URL 协议：javascript:, vbscript:, data: (仅在 href/src 中)
 *
 * 保留：
 * - SVG 元素和属性（含 style, transform, class 等）
 * - foreignObject 及其 HTML 子元素（div, span, p 等）
 * - style 元素（Mermaid 的 CSS 样式规则）
 * - xmlns 属性（foreignObject 中 HTML 渲染所需）
 */
export function sanitizeMermaidSvg(svg: string): string {
  if (!svg || typeof svg !== 'string') return '';

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svg, 'image/svg+xml');

    // 检查解析错误
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      // 解析失败时回退到原始字符串（Mermaid 通常生成合法 SVG）
      return svg;
    }

    const walker = document.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
    const elementsToRemove: Element[] = [];

    while (walker.nextNode()) {
      const el = walker.currentNode as Element;
      const tagName = el.tagName.toLowerCase();

      // 1. 移除危险元素
      if (DANGEROUS_TAGS.has(tagName)) {
        elementsToRemove.push(el);
        continue;
      }

      // 2. 移除事件处理器属性和危险 URL
      const attrs = Array.from(el.attributes);
      for (const attr of attrs) {
        if (DANGEROUS_ATTR_PATTERN.test(attr.name)) {
          el.removeAttribute(attr.name);
        } else if (
          (attr.name === 'href' || attr.name === 'src' || attr.name === 'xlink:href') &&
          DANGEROUS_PROTOCOLS.test(attr.value) &&
          !SAFE_PROTOCOLS.test(attr.value)
        ) {
          el.removeAttribute(attr.name);
        }
      }
    }

    // 批量移除危险元素
    for (const el of elementsToRemove) {
      el.parentNode?.removeChild(el);
    }

    // 序列化清理后的 SVG
    const serializer = new XMLSerializer();
    return serializer.serializeToString(doc.documentElement);
  } catch {
    // 异常时返回原始 SVG（容错）
    return svg;
  }
}
