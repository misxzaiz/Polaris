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

import { memo, useCallback, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { DeferredMermaidDiagram } from '../components/Chat/DeferredMermaidDiagram';
import { MarkdownRenderCache, MARKDOWN_ALLOWED_TAGS, MARKDOWN_ALLOWED_ATTR, wrapTables } from './cache';

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

    // 查找链接 [text](url) - 只匹配开头位置
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      // 正则以 ^ 开头，匹配成功时必定在开头位置
      parts.push({
        type: 'link',
        content: linkMatch[1],
        href: linkMatch[2]
      });
      remaining = remaining.slice(linkMatch[0].length);
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
  // 标准化：将单个换行符替换为空格（与 Markdown 规范一致）
  // 段落内的单个 \n 应视为连续文本，不应产生视觉换行
  // \n\n 已在 ProgressiveStreamingMarkdown 层面处理（用于段落分割）
  const normalizedContent = useMemo(() => content.replace(/\n/g, ' '), [content]);
  const parts = useMemo(() => parseInlineMarkdown(normalizedContent), [normalizedContent]);

  return (
    <span className="break-words">
      {parts.map((part, index) => renderPart(part, index))}
    </span>
  );
});

/**
 * 检测内容是否包含未闭合的代码块
 * 按行处理：仅当行首出现 ``` 时切换开关状态
 * 同行内的 ``` 对（如 ```code```）视为行内代码，跳过
 * 这样可以正确处理代码块内容中出现的 ```
 */
export function hasOpenCodeBlock(content: string): boolean {
  let inCodeBlock = false;
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      // 同行内如果出现两对 ```（如 ```code```），视为行内代码，跳过
      const afterFirst = trimmed.slice(3);
      if (afterFirst.includes('```')) {
        continue;
      }
      inCodeBlock = !inCodeBlock;
    }
  }
  return inCodeBlock;
}

/** 段落分割正则（编译一次，避免每次渲染重新创建） */
const PARAGRAPH_SPLIT_RE = /\n\n+/;

/**
 * 分割内容：将代码块、Mermaid 图表和普通文本分开
 *
 * 返回片段数组，标记每段是否已完成（不会再变化）：
 * - 代码块之前的文本：completed = true
 * - 最后一个已关闭代码块之后的文本：completed = false（可能还会追加）
 * - 已关闭的代码块：completed = true
 * - 未闭合的代码块标记：completed = false
 * - Mermaid 图表块：completed = true（已完整闭合）
 */
export function splitByCodeBlocks(content: string): Array<{
  type: 'text' | 'code-block' | 'mermaid-block';
  content: string;
  language?: string;
  completed: boolean;
}> {
  const parts: Array<{ type: 'text' | 'code-block' | 'mermaid-block'; content: string; language?: string; completed: boolean }> = [];

  // 匹配已关闭的 Mermaid 代码块：```mermaid\ncode\n```（支持可选空格）
  const mermaidRegex = /`{3}\s*mermaid\s*\n([\s\S]*?)`{3}/g;

  // 匹配已关闭的普通代码块：```lang\ncode\n```（排除 mermaid，lang 可为空）
  // 支持：```typescript\ncode\n``` 或 ```\ncode\n```
  const codeBlockRegex = /`{3}(\w*)\n([\s\S]*?)`{3}/g;

  // 合并处理：先找出所有代码块的位置，然后按顺序处理
  interface BlockMatch {
    index: number;
    endIndex: number;
    type: 'code-block' | 'mermaid-block';
    content: string;
    language?: string;
  }

  const allBlocks: BlockMatch[] = [];

  // 找出所有 Mermaid 块
  let mermaidMatch: RegExpExecArray | null;
  while ((mermaidMatch = mermaidRegex.exec(content)) !== null) {
    allBlocks.push({
      index: mermaidMatch.index,
      endIndex: mermaidMatch.index + mermaidMatch[0].length,
      type: 'mermaid-block',
      content: mermaidMatch[1].trim(),
    });
  }

  // 找出所有普通代码块（排除 mermaid）
  let codeMatch: RegExpExecArray | null;
  codeBlockRegex.lastIndex = 0;
  while ((codeMatch = codeBlockRegex.exec(content)) !== null) {
    // 检查是否是 mermaid（已在上面处理）
    if (codeMatch[1].toLowerCase() === 'mermaid') continue;

    // 检查是否与其他块重叠
    const overlaps = allBlocks.some(
      b => (codeMatch!.index >= b.index && codeMatch!.index < b.endIndex) ||
           (codeMatch!.index + codeMatch![0].length > b.index && codeMatch!.index + codeMatch![0].length <= b.endIndex)
    );
    if (overlaps) continue;

    allBlocks.push({
      index: codeMatch.index,
      endIndex: codeMatch.index + codeMatch[0].length,
      type: 'code-block',
      content: codeMatch[2],
      language: codeMatch[1] || undefined,
    });
  }

  // 按位置排序
  allBlocks.sort((a, b) => a.index - b.index);

  // 处理所有块和文本
  let lastIndex = 0;
  for (const block of allBlocks) {
    // 添加块之前的文本（已完成的）
    if (block.index > lastIndex) {
      parts.push({
        type: 'text',
        content: content.slice(lastIndex, block.index),
        completed: true,
      });
    }

    // 添加代码块或 Mermaid 块
    parts.push({
      type: block.type,
      content: block.content,
      language: block.language,
      completed: true,
    });

    lastIndex = block.endIndex;
  }

  // 处理最后一个已关闭代码块之后的内容
  const remaining = content.slice(lastIndex);
  if (remaining) {
    // 检查是否有未闭合的代码块
    const openBlockMatch = remaining.match(/```(\w*)\n?([\s\S]*)$/);
    if (openBlockMatch) {
      // 有未闭合的代码块
      // 代码块标记之前的文本是已完成的
      const beforeOpen = remaining.slice(0, remaining.indexOf('```'));
      if (beforeOpen) {
        parts.push({
          type: 'text',
          content: beforeOpen,
          completed: true,
        });
      }
      // 未闭合的代码块部分作为未完成的文本
      parts.push({
        type: 'text',
        content: remaining.slice(remaining.indexOf('```')),
        completed: false,
      });
    } else {
      // 没有未闭合的代码块，但这段文本可能是未完成的（流式还在追加）
      parts.push({
        type: 'text',
        content: remaining,
        completed: false,
      });
    }
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
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [content]);

  return (
    <div className="rounded-lg overflow-hidden bg-background-base border border-border-subtle group relative">
      <div className="flex items-center justify-between px-3 py-1.5 bg-background-elevated border-b border-border-subtle">
        <span className="text-xs text-text-tertiary font-mono">{language || ''}</span>
        <button
          onClick={handleCopy}
          className="text-xs text-text-tertiary hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
          title="复制"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="code-block-pre p-3 overflow-x-auto">
        <code className="text-sm text-text-secondary font-mono whitespace-pre">
          {content}
        </code>
      </pre>
    </div>
  );
});

export default LightweightMarkdown;

// ============================================================================
// 渐进式流式 Markdown 渲染器
// ============================================================================

/** DOMPurify 安全配置（复用共享常量，含 GFM 任务列表支持） */
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: MARKDOWN_ALLOWED_TAGS,
  ALLOWED_ATTR: MARKDOWN_ALLOWED_ATTR,
};

/** 流式渲染专用 Markdown 缓存实例（30 条上限，1 分钟 TTL） */
const streamingMdCache = new MarkdownRenderCache(30);

/** 将 Markdown 内容解析并净化为安全 HTML */
function sanitizeMarkdown(content: string): string {
  const raw = marked.parse(content) as string;
  const sanitized = DOMPurify.sanitize(raw, SANITIZE_CONFIG);
  return wrapTables(sanitized);
}

/**
 * 已完成文本块渲染器（单一容器）
 *
 * 所有段落渲染在同一容器中，<p> margin 正确折叠，避免独立 div 包裹导致间距翻倍。
 * 使用 CSS contain: content 限制重排范围。
 */
const CompletedTextBlock = memo(function CompletedTextBlock({
  content,
}: {
  content: string;
  blockIndex?: number;
}) {
  const html = useMemo(() => {
    if (!content.trim()) return null;
    return sanitizeMarkdown(content);
  }, [content]);

  if (!html) return null;

  return (
    <div
      className="break-words"
      style={{ contain: 'content' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

/**
 * 渐进式流式 Markdown 渲染器
 *
 * 核心改动：已完成段落合并到同一容器渲染，避免独立 div 包裹导致 <p> margin 不折叠。
 *
 * 策略：
 * 1. 已完成内容 → 单一容器 + marked + DOMPurify（<p> margin 折叠，无多余空行）
 * 2. 流式最后一段 → LightweightMarkdown（轻量行内渲染）
 * 3. 代码块 → StreamingCodeBlock / DeferredMermaidDiagram
 * 4. CSS contain: content 限制重排范围
 */
export const ProgressiveStreamingMarkdown = memo(function ProgressiveStreamingMarkdown({
  content,
  completed = false,
}: {
  content: string;
  completed?: boolean;
}) {
  const result = useMemo(() => {
    if (!content) return null;

    if (content.length > 50000) {
      return <span className="whitespace-pre-wrap break-words">{content}</span>;
    }

    const codeBlockCount = (content.match(/```/g) || []).length;

    // 无代码块路径
    if (codeBlockCount === 0) {
      // 已完成：单一容器渲染全部内容
      if (completed) {
        return (
          <div className="break-words" style={{ contain: 'content' }}
            dangerouslySetInnerHTML={{ __html: streamingMdCache.render(content) }} />
        );
      }

      // 流式：按段落分割
      const paragraphs = content.split(PARAGRAPH_SPLIT_RE);

      if (paragraphs.length <= 1) {
        return <LightweightMarkdown content={content} />;
      }

      // 已完成段落合并渲染 + 最后一段轻量渲染
      // 关键：已完成段落在同一容器内，<p> margin 折叠，不会出现多余空行
      const completedContent = paragraphs.slice(0, -1).join('\n\n') + '\n\n';
      const lastPara = paragraphs[paragraphs.length - 1];

      return (
        <>
          <div className="break-words" style={{ contain: 'content' }}
            dangerouslySetInnerHTML={{ __html: streamingMdCache.render(completedContent) }} />
          <LightweightMarkdown content={lastPara} />
        </>
      );
    }

    // 有代码块路径
    const parts = splitByCodeBlocks(content);

    return (
      <div className="break-words">
        {parts.map((part, index) => {
          // Mermaid 图表块
          if (part.type === 'mermaid-block') {
            return (
              <DeferredMermaidDiagram
                key={`mermaid-${index}`}
                code={part.content}
                id={`mermaid-${Date.now()}-${index}`}
                isStreaming={!completed}
              />
            );
          }

          // 代码块
          if (part.type === 'code-block') {
            return (
              <StreamingCodeBlock
                key={`code-${index}`}
                content={part.content}
                language={part.language}
              />
            );
          }

          // 已完成文本：单一容器渲染
          if (part.completed) {
            return (
              <CompletedTextBlock
                key={`ctext-${index}`}
                content={part.content}
                blockIndex={index}
              />
            );
          }

          // 未完成文本 + completed：整段完整渲染
          if (completed) {
            return (
              <CompletedTextBlock
                key={`ctext-${index}`}
                content={part.content}
                blockIndex={index}
              />
            );
          }

          // 未完成文本（流式中）：段落级渐进渲染
          const paragraphs = part.content.split(PARAGRAPH_SPLIT_RE);
          if (paragraphs.length <= 1) {
            return <LightweightMarkdown key={`ltext-${index}`} content={part.content} />;
          }

          // 已完成段落合并 + 最后一段轻量
          const completedParasContent = paragraphs.slice(0, -1).join('\n\n') + '\n\n';
          const lastPara = paragraphs[paragraphs.length - 1];

          return (
            <span key={`streaming-${index}`}>
              <div className="break-words" style={{ contain: 'content' }}
                dangerouslySetInnerHTML={{ __html: streamingMdCache.render(completedParasContent) }} />
              <LightweightMarkdown content={lastPara} />
            </span>
          );
        })}
      </div>
    );
  }, [content, completed]);

  return result;
});
