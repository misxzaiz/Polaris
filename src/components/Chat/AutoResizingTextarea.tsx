/**
 * 自适应高度文本框组件
 *
 * 特点：
 * - 根据 content 自动调整高度
 * - 支持最大/最小高度限制
 * - 组件切换时正确重置高度
 */
import { forwardRef, useRef, useLayoutEffect } from 'react';

interface AutoResizingTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  maxHeight?: number;
  minHeight?: number;
}

export const AutoResizingTextarea = forwardRef<HTMLTextAreaElement, AutoResizingTextareaProps>(
  ({ value, maxHeight = 200, minHeight = 40, className = '', ...props }, ref) => {
    const innerRef = useRef<HTMLTextAreaElement>(null);
    const textareaRef = (ref as React.RefObject<HTMLTextAreaElement>) || innerRef;

    // 使用 useLayoutEffect 确保在 DOM 更新后同步计算高度
    // 避免视觉闪烁
    useLayoutEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      // 先重置高度为 auto，以获取真实的 scrollHeight
      textarea.style.height = 'auto';
      // 计算新高度：在 minHeight 和 maxHeight 之间
      const newHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
      textarea.style.height = `${newHeight}px`;
    }, [value, maxHeight, minHeight]); // 注意：不依赖 textareaRef，ref 对象是稳定的

    return (
      <textarea
        ref={textareaRef}
        value={value}
        className={className}
        style={{ minHeight: `${minHeight}px`, maxHeight: `${maxHeight}px` }}
        {...props}
      />
    );
  }
);

AutoResizingTextarea.displayName = 'AutoResizingTextarea';
