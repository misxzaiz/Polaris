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
 * 把 <html> 标记为正在 resize. V2 token (layout-tokens.css) 监听这个类名,
 * 拖动期间禁用所有 CSS transition, 避免槽位尺寸的过渡动画与实时拖动叠加产生
 * "拖泥带水"的视觉.
 */
function setHtmlResizing(active: boolean) {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (active) html.classList.add('layout-resizing');
  else html.classList.remove('layout-resizing');
}

/**
 * 面板拖拽手柄组件
 * 支持鼠标和触摸操作
 *
 * V2: 默认透明, 仅 hover/active 显现; 拖动期间挂 html.layout-resizing 暂停 transition.
 */
export function ResizeHandle({ direction, position, onDrag, onDragEnd, disabled = false }: ResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isHovering, setIsHovering] = useState(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;

    setIsDragging(true);
    setHtmlResizing(true);

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
      setHtmlResizing(false);
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
    setHtmlResizing(true);

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
      setHtmlResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      onDragEnd?.();
    };

    document.addEventListener('touchmove', handleTouchMove);
    document.addEventListener('touchend', handleTouchEnd);
  }, [disabled, direction, position, onDrag, onDragEnd]);

  // V2: 默认透明, hover 显现 1.5px 半透明, active 满色 2px.
  // baseClasses 控制 "命中区" — 永远是 4px(横向)/4px(纵向), 视觉条更细以避免侵占.
  const baseClasses = direction === 'horizontal'
    ? 'w-1 cursor-col-resize'
    : 'h-1 cursor-row-resize';

  const colorClasses = disabled
    ? 'bg-transparent'
    : isDragging
      ? 'bg-primary'
      : isHovering
        ? 'bg-primary/60'
        : 'bg-transparent';

  return (
    <div
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      className={`${baseClasses} ${colorClasses} transition-colors duration-150 flex-shrink-0`}
      style={{ touchAction: 'none' }}
      role="separator"
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
    />
  );
}
