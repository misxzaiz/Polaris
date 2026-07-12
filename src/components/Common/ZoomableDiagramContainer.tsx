/**
 * ZoomableDiagramContainer - 可缩放可拖拽的图表容器
 *
 * 提供统一的 Mermaid 图表缩放 + 拖拽平移能力。
 * 从 MermaidDiagram 的缩放逻辑提取，增加鼠标拖拽平移。
 *
 * 功能：
 * - Ctrl/Cmd + 滚轮缩放（0.3x - 3.0x）
 * - +/- 按钮缩放
 * - 鼠标左键拖拽平移
 * - 重置按钮（回到初始状态）
 * - 缩放百分比显示
 */

import { memo, useState, useRef, useCallback, useEffect, type ReactNode } from 'react';

/** 缩放配置 */
const ZOOM_CONFIG: {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
} = {
  min: 0.3,
  max: 3.0,
  step: 0.15,
  default: 1.0,
};

export interface ZoomableDiagramContainerProps {
  /** 图表内容的子元素 */
  children: ReactNode;
  /** 容器最小高度 */
  minHeight?: number;
  /** 是否正在加载 */
  loading?: boolean;
  /** 错误信息 */
  error?: string | null;
  /** 错误区域渲染（自定义错误展示） */
  errorRenderer?: (error: string) => ReactNode;
}

export const ZoomableDiagramContainer = memo(function ZoomableDiagramContainer({
  children,
  minHeight = 300,
  loading = false,
  error = null,
  errorRenderer,
}: ZoomableDiagramContainerProps) {
  const [scale, setScale] = useState(ZOOM_CONFIG.default);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);

  // 缩放操作
  const zoomIn = useCallback(() => {
    setScale(s => Math.min(s + ZOOM_CONFIG.step, ZOOM_CONFIG.max));
  }, []);

  const zoomOut = useCallback(() => {
    setScale(s => Math.max(s - ZOOM_CONFIG.step, ZOOM_CONFIG.min));
  }, []);

  const resetView = useCallback(() => {
    setScale(ZOOM_CONFIG.default);
    setTranslate({ x: 0, y: 0 });
  }, []);

  // Ctrl/Cmd + 滚轮缩放（以鼠标位置为中心）
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();

    const delta = e.deltaY > 0 ? -ZOOM_CONFIG.step : ZOOM_CONFIG.step;
    setScale(prev => {
      const next = Math.max(ZOOM_CONFIG.min, Math.min(prev + delta, ZOOM_CONFIG.max));
      // 以鼠标位置为中心缩放：调整偏移量保持鼠标下的内容不动
      if (prev !== next && viewportRef.current) {
        const rect = viewportRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const ratio = next / prev;
        setTranslate(t => ({
          x: mouseX - ratio * (mouseX - t.x),
          y: mouseY - ratio * (mouseY - t.y),
        }));
      }
      return next;
    });
  }, []);

  // 拖拽平移 — mousedown
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 仅左键拖拽
    if (e.button !== 0) return;
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      tx: translate.x,
      ty: translate.y,
    };
    e.preventDefault();
  }, [translate]);

  // 拖拽平移 — mousemove（挂载到 document）
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      setTranslate({
        x: dragStartRef.current.tx + dx,
        y: dragStartRef.current.ty + dy,
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const isReset = scale === ZOOM_CONFIG.default && translate.x === 0 && translate.y === 0;

  return (
    <div className="relative rounded-lg overflow-hidden border border-border-subtle bg-background-surface">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-background-elevated border-b border-border-subtle">
        {/* 缩小 */}
        <button
          className="p-1 rounded-md hover:bg-background-hover text-text-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={zoomOut}
          disabled={scale <= ZOOM_CONFIG.min}
          title="缩小"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>

        {/* 缩放百分比 */}
        <span className="text-xs text-text-tertiary min-w-[3rem] text-center tabular-nums">
          {Math.round(scale * 100)}%
        </span>

        {/* 放大 */}
        <button
          className="p-1 rounded-md hover:bg-background-hover text-text-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={zoomIn}
          disabled={scale >= ZOOM_CONFIG.max}
          title="放大"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>

        {/* 分隔线 */}
        <div className="w-px h-4 bg-border-subtle" />

        {/* 重置 */}
        <button
          className="px-2 py-0.5 text-xs rounded-md hover:bg-background-hover text-text-tertiary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={resetView}
          disabled={isReset}
          title="重置视图"
        >
          重置
        </button>

        {/* 提示 */}
        <div className="ml-auto text-xs text-text-muted">
          滚轮缩放 · 拖拽平移
        </div>
      </div>

      {/* 图表视口 */}
      <div
        ref={viewportRef}
        className="overflow-hidden cursor-grab active:cursor-grabbing"
        style={{ minHeight }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
      >
        <div
          style={{
            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            transformOrigin: '0 0',
            transition: isDragging ? 'none' : 'transform 0.15s ease-out',
            willChange: 'transform',
          }}
        >
          {children}
        </div>
      </div>

      {/* 加载状态 */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background-surface/80">
          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* 错误状态 */}
      {error && (
        errorRenderer ? errorRenderer(error) : (
          <div className="p-2 bg-red-500/10 border border-red-500/30 rounded m-2 text-xs text-red-400">
            渲染失败: {error}
          </div>
        )
      )}
    </div>
  );
});

ZoomableDiagramContainer.displayName = 'ZoomableDiagramContainer';
