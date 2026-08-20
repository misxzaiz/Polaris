/**
 * Markdown 工具函数
 * 处理 Mermaid 代码块的提取和处理
 */

/**
 * Mermaid 代码块信息
 */
export interface MermaidBlock {
  /** 占位符，用于在 Markdown 中标记 Mermaid 位置 */
  placeholder: string;
  /** Mermaid 图表代码 */
  code: string;
  /** 唯一标识符 */
  id: string;
}

/**
 * Markdown 处理结果
 */
export interface ProcessedMarkdown {
  /** 移除 Mermaid 代码块后的 Markdown */
  cleanedMarkdown: string;
  /** 提取的 Mermaid 代码块列表 */
  mermaidBlocks: MermaidBlock[];
}

/**
 * 从 Markdown 中提取 Mermaid 代码块
 *
 * @param markdown - 原始 Markdown 文本
 * @returns 处理后的 Markdown 和提取的 Mermaid 代码块
 *
 * @example
 * ```ts
 * const result = extractMermaidBlocks(`
 *   # 标题
 *   ```mermaid
 *   graph TD
 *     A --> B
 *   ```
 * `);
 * // result.cleanedMarkdown: "# 标题\n__MERMAID_0__"
 * // result.mermaidBlocks: [{ placeholder: "__MERMAID_0__", code: "graph TD\n  A --> B", id: "mermaid-0" }]
 * ```
 */
export function extractMermaidBlocks(markdown: string): ProcessedMarkdown {
  const mermaidBlocks: MermaidBlock[] = [];
  let blockIndex = 0;

  // 正则匹配 ```mermaid 代码块
  // 支持多种写法：
  // - ```mermaid
  // - ``` mermaid
  const mermaidRegex = /`{3}\s*mermaid\s*\n([\s\S]*?)`{3}/g;

  const cleaned = markdown.replace(mermaidRegex, (_match, code) => {
    const placeholder = `__MERMAID_${blockIndex}__`;
    const id = `mermaid-${Date.now()}-${blockIndex}`;

    mermaidBlocks.push({
      placeholder,
      code: code.trim(),
      id,
    });

    blockIndex++;
    return placeholder;
  });

  return {
    cleanedMarkdown: cleaned,
    mermaidBlocks,
  };
}

/**
 * 检查 Markdown 是否包含 Mermaid 代码块
 *
 * @param markdown - Markdown 文本
 * @returns 是否包含 Mermaid 代码块
 */
export function hasMermaidBlock(markdown: string): boolean {
  return /`{3}\s*mermaid\s*\n/i.test(markdown);
}

/**
 * 验证 Mermaid 代码块是否完整
 * 用于流式渲染时判断代码块是否闭合
 *
 * @param markdown - Markdown 文本
 * @returns 代码块是否完整
 */
export function isMermaidBlockComplete(markdown: string): boolean {
  const openMatches = (markdown.match(/`{3}\s*mermaid\s*\n/gi) || []).length;
  const closeMatches = (markdown.match(/`{3}/g) || []).length;

  // 闭合标签数量应该是开放标签的 2 倍（每个代码块有开始和结束）
  return closeMatches >= openMatches * 2;
}

/**
 * Markdown 分片类型
 * 用于将包含 Mermaid 代码块的 Markdown 拆分为多个片段
 */
export interface MarkdownPart {
  /** 分片类型 */
  type: 'text' | 'mermaid';
  /** 内容 */
  content: string;
  /** 唯一标识符（仅 mermaid 类型） */
  id?: string;
}

/**
 * 将包含 Mermaid 代码块的 Markdown 拆分为多个片段
 *
 * 这个函数将 Markdown 文本按照 Mermaid 代码块的位置拆分为多个片段，
 * 使得图表能够在正确的位置渲染。
 *
 * @param markdown - 原始 Markdown 文本
 * @returns 拆分后的片段数组
 *
 * @example
 * ```ts
 * const parts = splitMarkdownWithMermaid(`
 *   这是标题
 *   \`\`\`mermaid
 *   graph TD
 *     A --> B
 *   \`\`\`
 *   这是后续内容
 * `);
 * // 返回:
 * // [
 * //   { type: 'text', content: '这是标题\n\n' },
 * //   { type: 'mermaid', content: 'graph TD\n  A --> B', id: 'mermaid-xxx-0' },
 * //   { type: 'text', content: '\n这是后续内容' }
 * // ]
 * ```
 */
export function splitMarkdownWithMermaid(markdown: string): MarkdownPart[] {
  const parts: MarkdownPart[] = [];
  let lastIndex = 0;
  let mermaidIndex = 0;

  // 正则匹配 ```mermaid 代码块
  // 注意：使用非贪婪匹配和全局标志
  const mermaidRegex = /`{3}\s*mermaid\s*\n([\s\S]*?)`{3}/gi;
  let match;

  while ((match = mermaidRegex.exec(markdown)) !== null) {
    const [fullMatch, mermaidCode] = match;
    const matchStart = match.index;
    const matchEnd = matchStart + fullMatch.length;

    // 添加 Mermaid 代码块之前的文本（如果有）
    if (matchStart > lastIndex) {
      const textContent = markdown.slice(lastIndex, matchStart);
      if (textContent.trim()) {
        parts.push({
          type: 'text',
          content: textContent,
        });
      }
    }

    // 添加 Mermaid 代码块
    parts.push({
      type: 'mermaid',
      content: mermaidCode.trim(),
      id: `mermaid-${Date.now()}-${mermaidIndex}`,
    });

    mermaidIndex++;
    lastIndex = matchEnd;
  }

  // 添加剩余的文本（如果有）
  if (lastIndex < markdown.length) {
    const remainingContent = markdown.slice(lastIndex);
    if (remainingContent.trim()) {
      parts.push({
        type: 'text',
        content: remainingContent,
      });
    }
  }

  // 如果没有找到任何 Mermaid 代码块，返回整个文本
  if (parts.length === 0) {
    return [{ type: 'text', content: markdown }];
  }

  return parts;
}
