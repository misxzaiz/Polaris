/**
 * 轻量级 Markdown 渲染器
 *
 * 专为流式渲染设计，只处理行内格式，不做复杂的块级解析
 * 性能优化：
 * - 只处理可见的格式化元素
 * - 不处理代码块语法高亮（流式阶段）
 * - 不处理表格、Mermaid 等复杂元素
 * - 使用简单的字符串匹配，避免复杂的正则
 */

import { memo, useMemo } from 'react';

/** 渲染片段类型 */
interface RenderPart {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link' | 'strikethrough';
  content: string;
  href?: string;
}

/**
 * 快速解析行内 Markdown 元素
 * 只处理：粗体、斜体、行内代码、链接、删除线
 * 不处理：代码块、标题、列表、表格等块级元素
 */
function parseInlineMarkdown(content: string): RenderPart[] {
  const parts: RenderPart[] = [];
  let remaining = content;
  let key = 0;

  // 安全限制：最大处理长度
  const MAX_LENGTH = 50000;
  if (content.length > MAX_LENGTH) {
    return [{ type: 'text', content }];
  }

  while (remaining.length > 0) {
    // 找到最近的特殊标记
    const markers = [
      { pattern: '**', type: 'bold' as const },
      { pattern: '__', type: 'bold' as const },
      { pattern: '*', type: 'italic' as const },
      { pattern: '_', type: 'italic' as const },
      { pattern: '`', type: 'code' as const },
      { pattern: '~~', type: 'strikethrough' as const },
    ];

    // 查找链接 [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      // 先添加之前的普通文本
      if (linkMatch.index! > 0) {
        parts.push({ type: 'text', content: remaining.slice(0, linkMatch.index) });
      }
      parts.push({
        type: 'link',
        content: linkMatch[1],
        href: linkMatch[2]
      });
      remaining = remaining.slice(linkMatch.index! + linkMatch[0].length);
      continue;
    }

    // 找到最近的一个标记
    let nearestIndex = Infinity;
    let nearestMarker: typeof markers[0] | null = null;

    for (const marker of markers) {
      const idx = remaining.indexOf(marker.pattern);
      if (idx !== -1 && idx < nearestIndex) {
        nearestIndex = idx;
        nearestMarker = marker;
      }
    }

    // 也检查链接
    const linkStart = remaining.indexOf('[');
    if (linkStart !== -1 && linkStart < nearestIndex) {
      // 添加之前的文本
      if (linkStart > 0) {
        parts.push({ type: 'text', content: remaining.slice(0, linkStart) });
        remaining = remaining.slice(linkStart);
        continue;
      }
      // 尝试匹配链接
      const match = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (match) {
        parts.push({
          type: 'link',
          content: match[1],
          href: match[2]
        });
        remaining = remaining.slice(match[0].length);
        continue;
      }
      // 不是有效链接，当作普通文本
      parts.push({ type: 'text', content: '[' });
      remaining = remaining.slice(1);
      continue;
    }

    if (nearestIndex === Infinity || !nearestMarker) {
      // 没有更多标记，添加剩余文本
      parts.push({ type: 'text', content: remaining });
      break;
    }

    // 添加标记之前的普通文本
    if (nearestIndex > 0) {
      parts.push({ type: 'text', content: remaining.slice(0, nearestIndex) });
    }

    // 根据标记类型处理
    const afterMarker = remaining.slice(nearestIndex + nearestMarker.pattern.length);

    if (nearestMarker.type === 'code') {
      // 行内代码：找结束的 `
      const endIdx = afterMarker.indexOf('`');
      if (endIdx !== -1) {
        const codeContent = afterMarker.slice(0, endIdx);
        parts.push({ type: 'code', content: codeContent });
        remaining = afterMarker.slice(endIdx + 1);
      } else {
        // 没有结束标记，当作普通文本
        parts.push({ type: 'text', content: remaining.slice(nearestIndex, nearestIndex + 1) });
        remaining = afterMarker;
      }
    } else if (nearestMarker.type === 'bold') {
      // 粗体：找结束的 ** 或 __
      const endIdx = afterMarker.indexOf(nearestMarker.pattern);
      if (endIdx !== -1 && endIdx > 0) {
        const boldContent = afterMarker.slice(0, endIdx);
        parts.push({ type: 'bold', content: boldContent });
        remaining = afterMarker.slice(endIdx + nearestMarker.pattern.length);
      } else {
        // 没有结束标记，当作普通文本
        parts.push({ type: 'text', content: remaining.slice(nearestIndex, nearestIndex + 2) });
        remaining = afterMarker;
      }
    } else if (nearestMarker.type === 'italic') {
      // 斜体：找结束的 * 或 _
      // 注意：需要处理 ** 的情况（优先粗体）
      const endIdx = afterMarker.indexOf(nearestMarker.pattern);
      if (endIdx !== -1 && endIdx > 0) {
        // 确保结束标记后面不是另一个 *（避免与粗体冲突）
        const afterEnd = afterMarker.slice(endIdx + 1);
        if (nearestMarker.pattern === '*' && afterEnd.startsWith('*')) {
          // 这应该是 ** 的开始，当作普通文本
          parts.push({ type: 'text', content: remaining.slice(nearestIndex, nearestIndex + 1) });
          remaining = afterMarker;
        } else {
          const italicContent = afterMarker.slice(0, endIdx);
          parts.push({ type: 'italic', content: italicContent });
          remaining = afterMarker.slice(endIdx + 1);
        }
      } else {
        // 没有结束标记，当作普通文本
        parts.push({ type: 'text', content: remaining.slice(nearestIndex, nearestIndex + 1) });
        remaining = afterMarker;
      }
    } else if (nearestMarker.type === 'strikethrough') {
      // 删除线：找结束的 ~~
      const endIdx = afterMarker.indexOf('~~');
      if (endIdx !== -1 && endIdx > 0) {
        const strikeContent = afterMarker.slice(0, endIdx);
        parts.push({ type: 'strikethrough', content: strikeContent });
        remaining = afterMarker.slice(endIdx + 2);
      } else {
        // 没有结束标记，当作普通文本
        parts.push({ type: 'text', content: remaining.slice(nearestIndex, nearestIndex + 2) });
        remaining = afterMarker;
      }
    }

    // 安全检查：防止无限循环
    key++;
    if (key > 1000) {
      parts.push({ type: 'text', content: remaining });
      break;
    }
  }

  return parts;
}

/**
 * 渲染行内 Markdown 片段
 */
function renderPart(part: RenderPart, index: number): React.ReactNode {
  switch (part.type) {
    case 'bold':
      return <strong key={index}>{part.content}</strong>;
    case 'italic':
      return <em key={index}>{part.content}</em>;
    case 'code':
      return (
        <code
          key={index}
          className="px-1.5 py-0.5 bg-background-surface rounded text-primary font-mono text-sm"
        >
          {part.content}
        </code>
      );
    case 'link':
      return (
        <a
          key={index}
          href={part.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          {part.content}
        </a>
      );
    case 'strikethrough':
      return <del key={index}>{part.content}</del>;
    default:
      return part.content;
  }
}

/**
 * 轻量级 Markdown 渲染组件
 * 专为流式渲染优化，只处理行内格式
 */
export const LightweightMarkdown = memo(function LightweightMarkdown({
  content
}: {
  content: string
}) {
  const parts = useMemo(() => parseInlineMarkdown(content), [content]);

  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((part, index) => renderPart(part, index))}
    </span>
  );
});

/**
 * 检测内容是否包含代码块标记
 * 用于流式阶段判断是否需要特殊处理
 */
export function hasOpenCodeBlock(content: string): boolean {
  const codeBlockCount = (content.match(/```/g) || []).length;
  return codeBlockCount % 2 !== 0;
}

/**
 * 分割内容：将代码块和普通文本分开
 * 返回片段数组，每段标记是否在代码块内
 */
export function splitByCodeBlocks(content: string): Array<{
  type: 'text' | 'code-block';
  content: string;
  language?: string;
}> {
  const parts: Array<{ type: 'text' | 'code-block'; content: string; language?: string }> = [];

  // 匹配代码块：```lang\ncode\n```
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // 添加代码块之前的文本
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        content: content.slice(lastIndex, match.index),
      });
    }

    // 添加代码块
    parts.push({
      type: 'code-block',
      content: match[2],
      language: match[1] || undefined,
    });

    lastIndex = match.index + match[0].length;
  }

  // 检查是否有未闭合的代码块
  const openBlockMatch = content.slice(lastIndex).match(/```(\w*)\n?([\s\S]*)$/);
  if (openBlockMatch) {
    // 有未闭合的代码块
    parts.push({
      type: 'text',
      content: content.slice(lastIndex),
    });
  } else if (lastIndex < content.length) {
    // 添加剩余文本
    parts.push({
      type: 'text',
      content: content.slice(lastIndex),
    });
  }

  return parts;
}

/**
 * 流式阶段的代码块渲染
 * 显示代码块标记但不高亮
 */
export const StreamingCodeBlock = memo(function StreamingCodeBlock({
  content,
  language,
}: {
  content: string;
  language?: string;
}) {
  return (
    <div className="my-2 rounded-lg overflow-hidden bg-background-base border border-border-subtle">
      {language && (
        <div className="px-3 py-1.5 bg-background-elevated border-b border-border-subtle">
          <span className="text-xs text-text-tertiary font-mono">{language}</span>
        </div>
      )}
      <pre className="p-3 overflow-x-auto">
        <code className="text-sm text-text-secondary font-mono whitespace-pre">
          {content}
        </code>
      </pre>
    </div>
  );
});

export default LightweightMarkdown;
