/**
 * 思考过程块渲染器 - 增强版可折叠展示
 */

import { memo, useState, useEffect, useMemo } from 'react';
import { Brain, ChevronDown, ChevronRight, ListOrdered } from 'lucide-react';
import type { ThinkingBlock } from '@/types';
import { extractThinkingSteps } from '../chatUtils/thinkingSteps';

export const ThinkingBlockRenderer = memo(function ThinkingBlockRenderer({
  block,
  isStreaming = false
}: {
  block: ThinkingBlock;
  isStreaming?: boolean;
}) {
  // 流式期间展开显示思考内容，结束后折叠
  const [isCollapsed, setIsCollapsed] = useState(() => {
    // 如果有明确的 collapsed 属性，使用它
    if (block.collapsed !== undefined) return block.collapsed;
    // 流式时展开，结束后折叠
    return !isStreaming;
  });

  // 流式结束时自动折叠
  useEffect(() => {
    if (!isStreaming) {
      setIsCollapsed(true);
    }
  }, [isStreaming]);

  // 计算字数统计
  const charCount = block.content.length;

  // 提取思考步骤
  const steps = useMemo(() => extractThinkingSteps(block.content), [block.content]);

  // 生成预览文本（折叠时显示前80字或步骤摘要）
  const previewText = useMemo(() => {
    if (steps.length >= 2) {
      // 有步骤时显示步骤数量和第一个步骤
      return `${steps.length} 个步骤: ${steps[0].text.slice(0, 40)}${steps[0].text.length > 40 ? '...' : ''}`;
    }
    // 无步骤时显示前80字
    return block.content.length > 80
      ? block.content.slice(0, 80) + '...'
      : block.content;
  }, [block.content, steps]);

  return (
    <div className="my-2 rounded-lg border border-primary/20 bg-gradient-to-r from-primary/5 to-transparent overflow-hidden">
      {/* 头部 - 可点击折叠 */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-primary/5 transition-colors"
      >
        <Brain className="w-4 h-4 text-primary shrink-0" />
        <span className="text-sm font-medium text-primary">思考过程</span>

        {/* 字数统计 */}
        <span className="text-xs text-text-tertiary ml-2">
          {charCount > 1000 ? `${(charCount / 1000).toFixed(1)}k` : charCount} 字
        </span>

        {/* 步骤数量徽章 */}
        {steps.length >= 2 && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-xs">
            <ListOrdered className="w-3 h-3" />
            {steps.length} 步骤
          </span>
        )}

        {/* 流式指示器 */}
        {isStreaming && (
          <span className="flex items-center gap-1 ml-2">
            <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
            <span className="text-xs text-primary">思考中...</span>
          </span>
        )}

        {/* 展开/折叠图标 */}
        <span className="ml-auto flex items-center gap-1">
          {isCollapsed ? (
            <ChevronRight className="w-4 h-4 text-text-muted" />
          ) : (
            <ChevronDown className="w-4 h-4 text-text-muted" />
          )}
        </span>
      </button>

      {/* 折叠时显示预览 */}
      {isCollapsed && previewText && (
        <div className="px-3 py-1.5 border-t border-primary/10 bg-background-surface/50">
          <p className="text-xs text-text-tertiary italic truncate">
            {previewText}
          </p>
        </div>
      )}

      {/* 展开时显示完整内容 */}
      {!isCollapsed && (
        <div className="px-3 py-2 border-t border-primary/10 bg-background-surface/30">
          {/* 完整思考内容 */}
          <div className="text-sm text-text-secondary whitespace-pre-wrap break-words leading-relaxed">
            {block.content}
          </div>
          {/* 流式光标 */}
          {isStreaming && (
            <span className="inline-flex ml-1">
              <span className="flex gap-0.5 items-end h-4">
                <span className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
});
