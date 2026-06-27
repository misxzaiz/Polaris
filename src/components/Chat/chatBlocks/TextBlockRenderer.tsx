/**
 * 文本内容块组件（支持 Mermaid 渲染 + 代码高亮）
 *
 * 渲染策略（与实际实现保持同步）：
 * 1. 流式更新频率由 store 层缓冲控制（createConversationStore 的
 *    STREAM_FLUSH_INTERVAL + \n\n 段落边界），本组件不做节流
 * 2. 流式/非流式统一走 ProgressiveStreamingMarkdown：
 *    - 流式（completed=false）：已完成段落完整渲染，最后一段轻量渲染
 *    - 非流式（completed=true）：全部完整 Markdown 渲染
 * 3. 统一渲染路径保证流式→完成切换时 DOM 结构稳定，避免视觉跳变
 */

import { memo } from 'react';
import type { TextBlock } from '@/types';
import { ProgressiveStreamingMarkdown } from '@/utils/lightweightMarkdown';
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
      <div className="chat-prose prose prose-invert max-w-none">
        <ProgressiveStreamingMarkdown content={block.content} completed={!isStreaming} />
      </div>
    </MarkdownImageSurface>
  );
});
