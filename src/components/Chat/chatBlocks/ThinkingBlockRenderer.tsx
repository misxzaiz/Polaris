/**
 * 思考过程块渲染器 - 极简风格，支持流式打字效果
 *
 * 设计原则：
 * - 与聊天界面融为一体，不抢眼
 * - 流式期间展开，显示打字光标
 * - 流式结束后自动折叠，展示内容预览
 */

import { memo, useState, useEffect } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import type { ThinkingBlock } from '@/types';

export const ThinkingBlockRenderer = memo(function ThinkingBlockRenderer({
  block,
  isStreaming = false
}: {
  block: ThinkingBlock;
  isStreaming?: boolean;
}) {
  // 流式期间展开显示思考内容，结束后折叠
  const [isCollapsed, setIsCollapsed] = useState(() => {
    if (block.collapsed !== undefined) return block.collapsed;
    return !isStreaming;
  });

  // 流式结束时自动折叠
  useEffect(() => {
    if (!isStreaming) {
      setIsCollapsed(true);
    }
  }, [isStreaming]);

  // 折叠时预览文本（内容前 60 字）
  const previewText = block.content.length > 60
    ? block.content.slice(0, 60) + '...'
    : block.content;

  return (
    <div
      className={`my-2 rounded-lg overflow-hidden border transition-colors ${
        isStreaming
          ? 'border-border-hover bg-background-elevated'
          : 'border-border bg-background-elevated'
      }`}
    >
      {/* 头部 - 可点击折叠 */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-background-hover transition-colors"
      >
        <Brain className="w-4 h-4 text-text-muted shrink-0" />

        <span className="text-xs font-medium text-text-secondary">思考</span>

        {/* 流式声波动画指示器 */}
        {isStreaming && (
          <span className="inline-flex items-center gap-1.5">
            <span className="flex items-end gap-[2px] h-3">
              <span className="w-[3px] rounded-sm bg-primary/60 animate-pulse" style={{ height: '6px', animationDelay: '0s' }} />
              <span className="w-[3px] rounded-sm bg-primary/60 animate-pulse" style={{ height: '10px', animationDelay: '0.15s' }} />
              <span className="w-[3px] rounded-sm bg-primary/60 animate-pulse" style={{ height: '8px', animationDelay: '0.3s' }} />
              <span className="w-[3px] rounded-sm bg-primary/60 animate-pulse" style={{ height: '11px', animationDelay: '0.45s' }} />
            </span>
            <span className="text-[11px] text-primary/70">思考中</span>
          </span>
        )}

        {/* 展开/折叠箭头 */}
        <ChevronDown
          className={`ml-auto w-3.5 h-3.5 text-text-muted transition-transform duration-200 ${
            !isCollapsed ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* 折叠时显示预览 */}
      {isCollapsed && previewText && (
        <div className="px-3 pb-2 pl-9">
          <p className="text-xs text-text-tertiary truncate leading-relaxed">
            {previewText}
          </p>
        </div>
      )}

      {/* 展开时显示完整内容 */}
      {!isCollapsed && (
        <div className="px-3 pb-2.5 pl-9 border-t border-border pt-2">
          <div className="text-sm text-text-secondary whitespace-pre-wrap break-words leading-relaxed">
            {block.content}
            {/* 流式打字光标 */}
            {isStreaming && (
              <span className="inline-block w-[2px] h-[15px] bg-primary/70 ml-0.5 align-text-bottom animate-pulse" />
            )}
          </div>
        </div>
      )}
    </div>
  );
});