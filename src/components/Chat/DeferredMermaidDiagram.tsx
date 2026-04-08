/**
 * 流式环境下的 Mermaid 延迟渲染组件
 *
 * 核心特性：
 * - 流式阶段不自动渲染图表，显示"点击渲染"按钮
 * - 避免流式阶段 mermaid.js 库加载和解码开销
 * - 用户主动点击后才触发渲染
 * - 渲染后与完整版 MermaidDiagram 功能一致
 */

import { memo, useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getMermaidConfig } from '../../utils/mermaid-config';
import {
  type ViewMode,
  type DiagramState,
  SCALE_CONFIG,
  getDiagramState,
  saveDiagramState,
  removeDiagramState,
} from './diagramState';

interface DeferredMermaidDiagramProps {
  /** Mermaid 图表代码 */
  code: string;
  /** 唯一标识符 */
  id: string;
  /** 是否处于流式状态 */
  isStreaming?: boolean;
}

/**
 * 渲染状态
 */
type RenderState = 'idle' | 'loading' | 'success' | 'error';

/**
 * 延迟渲染 Mermaid 图表组件
 *
 * 流式阶段显示占位符 + 渲染按钮，用户点击后才渲染
 * 流式结束后可自动渲染（可选）
 */
export const DeferredMermaidDiagram = memo(function DeferredMermaidDiagram({
  code,
  id,
  isStreaming = false,
}: DeferredMermaidDiagramProps) {
  const { t } = useTranslation('chat');
  const [renderState, setRenderState] = useState<RenderState>('idle');
  const [svg, setSvg] = useState<string>('');
  const [diagramState, setDiagramState] = useState<DiagramState>(() => getDiagramState(id));
  const [copySuccess, setCopySuccess] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasRequestedRender = useRef(false);
  const renderedCodeRef = useRef<string>('');

  // 组件卸载时清理全局状态，防止内存泄漏
  useEffect(() => {
    return () => removeDiagramState(id);
  }, [id]);

  // 更新状态并持久化
  const updateState = useCallback((updates: Partial<DiagramState>) => {
    setDiagramState(prev => {
      const newState = { ...prev, ...updates };
      saveDiagramState(id, newState);
      return newState;
    });
  }, [id]);

  // 渲染 Mermaid 图表
  const renderDiagram = useCallback(async () => {
    // 允许代码变更后重新渲染
    if (hasRequestedRender.current && renderedCodeRef.current === code) return;
    hasRequestedRender.current = true;

    if (!code || !code.trim()) {
      setRenderState('idle');
      return;
    }

    setRenderState('loading');

    try {
      // 动态导入 mermaid（懒加载）
      const mermaidModule = await import('mermaid');
      const mermaidInstance = mermaidModule.default;

      // 检查是否已初始化（mermaid 10.x 不支持 isInitialized 检查，直接调用 initialize）
      try {
        const config = getMermaidConfig('dark');
        mermaidInstance.initialize(config);
      } catch {
        // 可能已初始化，忽略错误
      }

      // 生成唯一 ID
      const uniqueId = `mermaid-${id}`;

      // 渲染图表
      const { svg } = await mermaidInstance.render(uniqueId, code);
      renderedCodeRef.current = code;
      setSvg(svg);
      setRenderState('success');
    } catch (err) {
      console.error('Mermaid render error:', err);
      setRenderState('error');
      setSvg('');
    }
  }, [code, id]);

  // 流式结束后自动渲染（非流式场景）
  useEffect(() => {
    if (!isStreaming && renderState === 'idle' && code?.trim()) {
      // 延迟一小段时间，确保 DOM 稳定
      const timer = setTimeout(() => {
        renderDiagram();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, renderState, code, renderDiagram]);

  // 事件处理
  const handleZoomIn = useCallback(() => {
    updateState({
      scale: Math.min(diagramState.scale + SCALE_CONFIG.step, SCALE_CONFIG.max),
    });
  }, [diagramState.scale, updateState]);

  const handleZoomOut = useCallback(() => {
    updateState({
      scale: Math.max(diagramState.scale - SCALE_CONFIG.step, SCALE_CONFIG.min),
    });
  }, [diagramState.scale, updateState]);

  const handleReset = useCallback(() => {
    updateState({ scale: SCALE_CONFIG.default });
  }, [updateState]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (diagramState.viewMode !== 'chart') return;
    if (!e.ctrlKey && !e.metaKey) return;

    e.preventDefault();
    const delta = e.deltaY > 0 ? -SCALE_CONFIG.step : SCALE_CONFIG.step;
    updateState({
      scale: Math.max(
        SCALE_CONFIG.min,
        Math.min(diagramState.scale + delta, SCALE_CONFIG.max)
      ),
    });
  }, [diagramState.viewMode, diagramState.scale, updateState]);

  const handleToggleView = useCallback((mode: ViewMode) => {
    updateState({ viewMode: mode });
  }, [updateState]);

  const handleCopySource = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
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

  // 错误状态
  if (renderState === 'error') {
    return (
      <div className="my-4 p-4 bg-danger-faint border border-danger/30 rounded-lg overflow-auto">
        <div className="flex items-start gap-2">
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

  // 加载状态
  if (renderState === 'loading') {
    return (
      <div className="my-4 p-6 bg-background-surface border border-border-subtle rounded-lg">
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            <span className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
          <p className="text-sm text-text-tertiary">{t('mermaidStream.generating')}</p>
        </div>
      </div>
    );
  }

  // 成功状态（已渲染）
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
              {t('mermaid.chart')}
            </button>
            <button
              className={`px-3 py-1 text-xs rounded-md transition-all ${
                diagramState.viewMode === 'source'
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-text-tertiary hover:text-text-secondary hover:bg-background-hover'
              }`}
              onClick={() => handleToggleView('source')}
            >
              {t('mermaid.source')}
            </button>
          </div>

          <div className="w-px h-4 bg-border-subtle" />

          {/* 图表模式：缩放控制 */}
          {diagramState.viewMode === 'chart' && (
            <>
              <button
                className="p-1.5 rounded-md hover:bg-background-hover text-text-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleZoomOut}
                disabled={diagramState.scale <= SCALE_CONFIG.min}
                title={t('mermaid.zoomOut')}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                </svg>
              </button>
              <span className="text-xs text-text-tertiary min-w-[3rem] text-center">
                {Math.round(diagramState.scale * 100)}%
              </span>
              <button
                className="p-1.5 rounded-md hover:bg-background-hover text-text-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleZoomIn}
                disabled={diagramState.scale >= SCALE_CONFIG.max}
                title={t('mermaid.zoomIn')}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </button>
              <div className="w-px h-4 bg-border-subtle" />
              <button
                className="px-2 py-1 text-xs rounded-md hover:bg-background-hover text-text-tertiary transition-colors"
                onClick={handleReset}
                disabled={diagramState.scale === SCALE_CONFIG.default}
                title={t('mermaid.resetZoom')}
              >
                {t('mermaid.reset')}
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
              title={t('mermaid.copySource')}
            >
              {copySuccess ? (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {t('mermaid.copied')}
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  {t('mermaid.copy')}
                </>
              )}
            </button>
          )}

          <div className="ml-auto text-xs text-text-muted">
            {diagramState.viewMode === 'chart' && 'Ctrl + 滚轮缩放'}
          </div>
        </div>

        {/* 内容区域 */}
        <div className="p-4">
          {diagramState.viewMode === 'chart' ? (
            <div
              className="overflow-auto"
              style={{ maxHeight: '600px' }}
            >
              <div
                style={{
                  transform: `scale(${diagramState.scale})`,
                  transformOrigin: 'top left',
                  transition: 'transform 0.2s ease-out',
                  willChange: 'transform',
                  minWidth: `${diagramState.scale * 100}%`,
                }}
              >
                <div dangerouslySetInnerHTML={{ __html: svg }} />
              </div>
            </div>
          ) : (
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

  // 空状态/未渲染（显示渲染按钮）
  return (
    <div
      ref={containerRef}
      className="my-4 bg-background-surface border border-border-subtle rounded-lg overflow-hidden"
    >
      {/* 占位符内容 */}
      <div className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-text-tertiary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span className="text-sm">Mermaid 图表</span>
          </div>
          <button
            onClick={renderDiagram}
            className="px-3 py-1.5 text-xs bg-primary/10 hover:bg-primary/20 text-primary rounded-md transition-colors flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            点击渲染
          </button>
        </div>
        {/* 源码预览（折叠状态） */}
        <details className="mt-3">
          <summary className="text-xs text-text-quaternary cursor-pointer hover:text-text-tertiary transition-colors">
            查看源码
          </summary>
          <pre className="mt-2 text-xs text-text-secondary bg-background-base p-2 rounded border border-border-subtle overflow-auto max-h-[200px]">
            <code className="font-mono whitespace-pre-wrap">{code}</code>
          </pre>
        </details>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.code === nextProps.code &&
    prevProps.id === nextProps.id &&
    prevProps.isStreaming === nextProps.isStreaming
  );
});
