/**
 * Mermaid 图表渲染组件
 *
 * 功能：
 * - 懒加载 mermaid 库，减少首屏体积
 * - IntersectionObserver：只在可见时渲染图表
 * - 支持暗色主题（匹配项目配色）
 * - 错误处理和友好提示
 * - 加载状态显示
 * - 图表缩放功能（鼠标滚轮 + 按钮）
 * - 源码/图表切换
 * - 复制源码功能
 */

import { memo, useEffect, useRef, useState, useCallback } from 'react';
import { getMermaidConfig } from '../../utils/mermaid-config';

interface MermaidDiagramProps {
  /** Mermaid 图表代码 */
  code: string;
  /** 唯一标识符（用于生成图表 ID） */
  id: string;
}

/**
 * 可见性检测阈值配置
 */
const INTERSECTION_OPTIONS: IntersectionObserverInit = {
  root: null,
  rootMargin: '100px', // 提前 100px 开始加载
  threshold: 0.1,      // 10% 可见时触发
};

/**
 * Mermaid 渲染状态
 */
type RenderState = 'idle' | 'loading' | 'success' | 'error';

/**
 * 视图模式
 */
type ViewMode = 'chart' | 'source';

/**
 * 图表状态
 */
interface DiagramState {
  viewMode: ViewMode;
  scale: number;
}

/**
 * 缩放配置
 */
const SCALE_CONFIG = {
  min: 0.5,   // 最小 50%
  max: 2.0,   // 最大 200%
  step: 0.1,  // 每次调整 10%
  default: 1.0, // 默认 100%
};

/**
 * 全局状态存储（每个图表独立）
 */
const diagramStates = new Map<string, DiagramState>();

/**
 * 获取图表状态
 */
function getDiagramState(id: string): DiagramState {
  if (!diagramStates.has(id)) {
    diagramStates.set(id, {
      viewMode: 'chart',
      scale: SCALE_CONFIG.default,
    });
  }
  return diagramStates.get(id)!;
}

/**
 * 保存图表状态
 */
function saveDiagramState(id: string, state: DiagramState) {
  diagramStates.set(id, state);
}

/**
 * MermaidDiagram 组件
 *
 * @example
 * ```tsx
 * <MermaidDiagram
 *   code="graph TD\n  A --> B"
 *   id="mermaid-1"
 * />
 * ```
 */
export const MermaidDiagram = memo(function MermaidDiagram({ code, id }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [renderState, setRenderState] = useState<RenderState>('idle');
  const [svg, setSvg] = useState<string>('');
  const [isVisible, setIsVisible] = useState(false); // 是否在视口中可见
  const hasRenderedRef = useRef(false); // 是否已渲染过（避免重复渲染）

  // 图表交互状态
  const [diagramState, setDiagramState] = useState<DiagramState>(() => getDiagramState(id));
  const [copySuccess, setCopySuccess] = useState(false);

  // 更新状态并持久化
  const updateState = useCallback((updates: Partial<DiagramState>) => {
    setDiagramState(prev => {
      const newState = { ...prev, ...updates };
      saveDiagramState(id, newState);
      return newState;
    });
  }, [id]);

  // ===== 可见性检测 =====
  useEffect(() => {
    const container = containerRef.current;
    if (!container || hasRenderedRef.current) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !hasRenderedRef.current) {
          setIsVisible(true);
          hasRenderedRef.current = true;
          observer.disconnect();
        }
      });
    }, INTERSECTION_OPTIONS);

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, []);

  // ===== Mermaid 渲染逻辑（只在可见时执行）=====
  useEffect(() => {
    // 只在可见时才渲染
    if (!isVisible) return;

    let mounted = true;
    let mermaidInstance: any = null;

    const renderDiagram = async () => {
      // 空代码不渲染
      if (!code || !code.trim()) {
        return;
      }

      setRenderState('loading');

      try {
        // 动态导入 mermaid（懒加载）
        const mermaidModule = await import('mermaid');
        mermaidInstance = mermaidModule.default;

        // 检查是否已初始化
        if (!mermaidInstance.isInitialized?.()) {
          const config = getMermaidConfig('dark');
          mermaidInstance.initialize(config);
        }

        // 生成唯一 ID（避免多个图表冲突）
        const uniqueId = `mermaid-${id}`;

        // 渲染图表
        const { svg } = await mermaidInstance.render(uniqueId, code);

        if (mounted) {
          setSvg(svg);
          setRenderState('success');
        }
      } catch (err) {
        if (mounted) {
          console.error('Mermaid render error:', err);
          setRenderState('error');
          setSvg('');
        }
      }
    };

    renderDiagram();

    return () => {
      mounted = false;
    };
  }, [isVisible, code, id]);

  // ===== 事件处理函数 =====

  // 放大
  const handleZoomIn = useCallback(() => {
    updateState({
      scale: Math.min(diagramState.scale + SCALE_CONFIG.step, SCALE_CONFIG.max)
    });
  }, [diagramState.scale, updateState]);

  // 缩小
  const handleZoomOut = useCallback(() => {
    updateState({
      scale: Math.max(diagramState.scale - SCALE_CONFIG.step, SCALE_CONFIG.min)
    });
  }, [diagramState.scale, updateState]);

  // 重置
  const handleReset = useCallback(() => {
    updateState({ scale: SCALE_CONFIG.default });
  }, [updateState]);

  // 鼠标滚轮缩放
  const handleWheel = useCallback((e: React.WheelEvent) => {
    // 只在图表模式且按住 Ctrl/Cmd 时缩放
    if (diagramState.viewMode !== 'chart') return;
    if (!e.ctrlKey && !e.metaKey) return;

    e.preventDefault();
    const delta = e.deltaY > 0 ? -SCALE_CONFIG.step : SCALE_CONFIG.step;
    updateState({
      scale: Math.max(
        SCALE_CONFIG.min,
        Math.min(diagramState.scale + delta, SCALE_CONFIG.max)
      )
    });
  }, [diagramState.viewMode, diagramState.scale, updateState]);

  // 切换视图模式
  const handleToggleView = useCallback((mode: ViewMode) => {
    updateState({ viewMode: mode });
  }, [updateState]);

  // 复制源码
  const handleCopySource = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      // 降级方案
      const textArea = document.createElement('textarea');
      textArea.value = code;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    }
  }, [code]);

  // ===== 渲染状态 =====

  // 1. 错误状态
  if (renderState === 'error') {
    return (
      <div className="my-4 p-4 bg-danger-faint border border-danger/30 rounded-lg overflow-auto">
        <div className="flex items-start gap-2">
          {/* 错误图标 */}
          <svg
            className="w-5 h-5 text-danger shrink-0 mt-0.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>

          <div className="flex-1 min-w-0">
            <p className="text-sm text-danger font-medium">图表渲染失败</p>
            <details className="mt-2">
              <summary className="text-xs text-text-tertiary cursor-pointer hover:text-text-secondary transition-colors">
                查看原始代码
              </summary>
              <pre className="mt-2 text-xs text-text-secondary bg-background-base p-3 rounded border border-border-subtle overflow-auto">
                <code>{code}</code>
              </pre>
            </details>
          </div>
        </div>
      </div>
    );
  }

  // 2. 加载状态
  if (renderState === 'loading') {
    return (
      <div className="my-4 p-6 bg-background-surface border border-border-subtle rounded-lg">
        <div className="flex items-center gap-3">
          {/* 加载动画 */}
          <div className="flex gap-1">
            <span className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
          <p className="text-sm text-text-tertiary">正在渲染图表...</p>
        </div>
      </div>
    );
  }

  // 3. 成功状态
  if (renderState === 'success' && svg) {
    return (
      <div
        ref={containerRef}
        className="my-4 bg-background-surface border border-border-subtle rounded-lg overflow-hidden"
        onWheel={handleWheel}
      >
        {/* 工具栏 */}
        <div className="flex items-center gap-2 px-3 py-2 bg-background-elevated border-b border-border-subtle">
          {/* 视图切换 Tab */}
          <div className="flex items-center gap-1 bg-background-base rounded-lg p-1">
            <button
              className={`px-3 py-1 text-xs rounded-md transition-all ${
                diagramState.viewMode === 'chart'
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-text-tertiary hover:text-text-secondary hover:bg-background-hover'
              }`}
              onClick={() => handleToggleView('chart')}
            >
              图表
            </button>
            <button
              className={`px-3 py-1 text-xs rounded-md transition-all ${
                diagramState.viewMode === 'source'
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-text-tertiary hover:text-text-secondary hover:bg-background-hover'
              }`}
              onClick={() => handleToggleView('source')}
            >
              源码
            </button>
          </div>

          {/* 分隔线 */}
          <div className="w-px h-4 bg-border-subtle" />

          {/* 图表模式：缩放控制 */}
          {diagramState.viewMode === 'chart' && (
            <>
              {/* 缩小按钮 */}
              <button
                className="p-1.5 rounded-md hover:bg-background-hover text-text-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleZoomOut}
                disabled={diagramState.scale <= SCALE_CONFIG.min}
                title="缩小 (Ctrl + 滚轮)"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                </svg>
              </button>

              {/* 缩放比例显示 */}
              <span className="text-xs text-text-tertiary min-w-[3rem] text-center">
                {Math.round(diagramState.scale * 100)}%
              </span>

              {/* 放大按钮 */}
              <button
                className="p-1.5 rounded-md hover:bg-background-hover text-text-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleZoomIn}
                disabled={diagramState.scale >= SCALE_CONFIG.max}
                title="放大 (Ctrl + 滚轮)"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </button>

              {/* 分隔线 */}
              <div className="w-px h-4 bg-border-subtle" />

              {/* 重置按钮 */}
              <button
                className="px-2 py-1 text-xs rounded-md hover:bg-background-hover text-text-tertiary transition-colors"
                onClick={handleReset}
                disabled={diagramState.scale === SCALE_CONFIG.default}
                title="重置缩放"
              >
                重置
              </button>
            </>
          )}

          {/* 源码模式：复制按钮 */}
          {diagramState.viewMode === 'source' && (
            <button
              className={`px-3 py-1.5 text-xs rounded-md transition-all flex items-center gap-1.5 ${
                copySuccess
                  ? 'bg-success text-white'
                  : 'hover:bg-background-hover text-text-tertiary'
              }`}
              onClick={handleCopySource}
              title="复制源码"
            >
              {copySuccess ? (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  已复制
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  复制
                </>
              )}
            </button>
          )}

          {/* 提示文本 */}
          <div className="ml-auto text-xs text-text-muted">
            {diagramState.viewMode === 'chart' && 'Ctrl + 滚轮缩放'}
          </div>
        </div>

        {/* 内容区域 */}
        <div className="p-4">
          {diagramState.viewMode === 'chart' ? (
            /* 图表视图 */
            <div
              ref={contentRef}
              className="overflow-auto"
              style={{
                maxHeight: '600px',
              }}
            >
              <div
                style={{
                  transform: `scale(${diagramState.scale})`,
                  transformOrigin: 'top left',  // 修改：从左上角开始缩放，避免左边被遮挡
                  transition: 'transform 0.2s ease-out',
                  willChange: 'transform',
                  // 补充：设置最小宽度确保容器能随缩放扩展
                  minWidth: `${diagramState.scale * 100}%`,
                }}
              >
                <div dangerouslySetInnerHTML={{ __html: svg }} />
              </div>
            </div>
          ) : (
            /* 源码视图 */
            <div className="bg-background-base rounded-lg p-4 overflow-auto max-h-[600px]">
              <pre className="text-sm">
                <code className="text-text-secondary font-mono whitespace-pre-wrap">{code}</code>
              </pre>
            </div>
          )}
        </div>
      </div>
    );
  }

  // 4. 空状态/未可见状态（显示占位符）
  return (
    <div
      ref={containerRef}
      className="my-4 p-6 bg-background-surface border border-border-subtle rounded-lg"
    >
      <div className="flex items-center justify-center gap-3">
        <svg className="w-5 h-5 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <span className="text-sm text-text-tertiary">图表将在滚动到可视区域时渲染</span>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // 自定义比较：只在代码或 ID 变化时重新渲染
  return prevProps.code === nextProps.code && prevProps.id === nextProps.id;
});
