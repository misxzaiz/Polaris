import { useState, useCallback } from 'react';

interface ResizeHandleProps {
  /** 拖拽方向 */
  direction: 'horizontal' | 'vertical';
  /** 拖拽位置 */
  position: 'left' | 'right';
  /** 拖拽回调 */
  onDrag: (delta: number) => void;
  /** 拖拽结束回调 */
  onDragEnd?: () => void;
  /** 是否禁用 */
  disabled?: boolean;
}

/**
 * 面板拖拽手柄组件
 * 支持鼠标和触摸操作
 */
export function ResizeHandle({ direction, position, onDrag, onDragEnd, disabled = false }: ResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;

    setIsDragging(true);

    // 添加全局样式，防止选中文字
    document.body.style.userSelect = 'none';
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';

    const handleMouseMove = (e: MouseEvent) => {
      if (direction === 'horizontal') {
        let delta = e.clientX - startX;
        // 如果手柄在面板左边，需要取反
        // 因为往左拖手柄（delta < 0）应该让面板变大
        if (position === 'left') {
          delta = -delta;
        }
        onDrag(delta);
      } else {
        let delta = e.clientY - startY;
        // 如果手柄在面板顶部，需要取反
        if (position === 'left') {  // 对于垂直方向，left 相当于 top
          delta = -delta;
        }
        onDrag(delta);
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      onDragEnd?.();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [disabled, direction, position, onDrag, onDragEnd]);

  // 触摸支持
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (disabled) return;
    const touch = e.touches[0];
    const startX = touch.clientX;
    const startY = touch.clientY;

    setIsDragging(true);

    document.body.style.userSelect = 'none';
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';

    const handleTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (direction === 'horizontal') {
        let delta = touch.clientX - startX;
        // 如果手柄在面板左边，需要取反
        if (position === 'left') {
          delta = -delta;
        }
        onDrag(delta);
      } else {
        let delta = touch.clientY - startY;
        // 如果手柄在面板顶部，需要取反
        if (position === 'left') {  // 对于垂直方向，left 相当于 top
          delta = -delta;
        }
        onDrag(delta);
      }
    };

    const handleTouchEnd = () => {
      setIsDragging(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      onDragEnd?.();
    };

    document.addEventListener('touchmove', handleTouchMove);
    document.addEventListener('touchend', handleTouchEnd);
  }, [disabled, direction, position, onDrag, onDragEnd]);

  const baseClasses = direction === 'horizontal'
    ? 'w-1.5 hover:w-2.5 cursor-col-resize'
    : 'h-1.5 hover:h-2.5 cursor-row-resize';

  const colorClasses = disabled
    ? 'bg-transparent'
    : isDragging
    ? 'bg-primary'
    : 'bg-white/20 hover:bg-primary/70';

  return (
    <div
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      className={`${baseClasses} ${colorClasses} transition-all duration-150 flex-shrink-0`}
      style={{ touchAction: 'none' }}
    />
  );
}
