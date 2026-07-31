/**
 * 思考过程块渲染器 - 呼吸光晕风格
 *
 * 设计：
 * - 蓝色调边框 + 微光呼吸动画
 * - 脉冲小圆点指示器
 * - 流式打字光标
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
    <>
      {/* 自定义动画 keyframes */}
      <style>{`
        @keyframes think-glow {
          0%, 100% {
            box-shadow: 0 0 6px rgba(59, 130, 246, 0.06);
            border-color: rgba(59, 130, 246, 0.15);
          }
          50% {
            box-shadow: 0 0 14px rgba(59, 130, 246, 0.15);
            border-color: rgba(59, 130, 246, 0.3);
          }
        }
        @keyframes think-dot {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.25); }
        }
      `}</style>
      <div
        className={`my-2 rounded-lg overflow-hidden border transition-colors ${
          isStreaming
            ? 'bg-[#0f1117]'
            : 'border-border bg-background-elevated'
        }`}
        style={isStreaming ? {
          animation: 'think-glow 2s ease-in-out infinite',
          borderColor: 'rgba(59, 130, 246, 0.15)',
        } : {}}
      >
        {/* 头部 - 可点击折叠 */}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] transition-colors"
        >
          {/* 脉冲圆点 */}
          {isStreaming && (
            <span
              className="w-[7px] h-[7px] rounded-full shrink-0 bg-primary/60"
              style={{ animation: 'think-dot 1.5s ease-in-out infinite' }}
            />
          )}

          <Brain className="w-4 h-4 text-primary/60 shrink-0" />

          <span className="text-xs font-medium text-primary/70">思考中</span>

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
          <div className="px-3 pb-2.5 pl-9 border-t border-white/5 pt-2">
            <div className="text-sm text-text-secondary whitespace-pre-wrap break-words leading-relaxed">
              {block.content}
              {/* 流式打字光标 */}
              {isStreaming && (
                <span className="inline-block w-[2px] h-[15px] bg-primary/60 ml-0.5 align-text-bottom animate-pulse" />
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
});