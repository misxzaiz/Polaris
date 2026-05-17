/**
 * 文本内容块组件（支持 Mermaid 渲染 + 代码高亮）
 *
 * 性能优化策略：
 * 1. 流式输出时使用节流（而非防抖），确保固定间隔渲染，提供更好的实时性
 * 2. 流式阶段显示简化版内容（纯文本），避免复杂 markdown 渲染
 * 3. 使用 useDeferredValue 降低渲染优先级，保持 UI 响应
 * 4. 流式结束后显示完整渲染结果
 */

import { memo } from 'react';
import type { TextBlock } from '../../../types';
import { ProgressiveStreamingMarkdown } from '../../../utils/lightweightMarkdown';
import { MarkdownImageSurface } from '../MarkdownImageSurface';

export const TextBlockRenderer = memo(function TextBlockRenderer({
  block,
  isStreaming = false,
}: {
  block: TextBlock;
  isStreaming?: boolean;
}) {
  // 统一渲染路径：流式和非流式使用同一组件
  // 流式时 completed=false（最后一段用轻量渲染）
  // 非流式时 completed=true（所有段落用完整 Markdown 渲染）
  // 优势：流式→非流式切换时无 DOM 结构变化，避免视觉跳变
  return (
    <MarkdownImageSurface>
      <div className="prose prose-invert prose-sm max-w-none">
        <ProgressiveStreamingMarkdown content={block.content} completed={!isStreaming} />
      </div>
    </MarkdownImageSurface>
  );
});
