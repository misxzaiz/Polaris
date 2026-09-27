/**
 * 窗口尺寸监听 Hook
 *
 * 用于响应式布局，检测窗口尺寸变化并自动切换小屏模式
 */

import { useState, useEffect, useCallback, useRef } from 'react';

export interface WindowSize {
  width: number;
  height: number;
}

export interface UseWindowSizeOptions {
  /** 小屏模式宽度阈值，默认 500 */
  compactThreshold?: number;
  /** 是否启用小屏模式检测，默认 true */
  enabled?: boolean;
}

export interface WindowSizeInfo extends WindowSize {
  isCompact: boolean;
}

/**
 * 检测窗口尺寸的 Hook
 *
 * @example
 * const { width, height, isCompact } = useWindowSize({ compactThreshold: 500 });
 */
export function useWindowSize(options: UseWindowSizeOptions = {}): WindowSizeInfo {
  const { compactThreshold = 500, enabled = true } = options;

  const [windowSize, setWindowSize] = useState<WindowSizeInfo>(() => {
    // 初始化时获取窗口尺寸
    if (typeof window !== 'undefined') {
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        isCompact: window.innerWidth < compactThreshold,
      };
    }
    return {
      width: 1200,
      height: 800,
      isCompact: false,
    };
  });

  // 用 ref 跟踪最近一次有效尺寸，处理 resize 事件中 width<=0 的瞬态值
  const windowSizeRef = useRef(windowSize);

  const handleResize = useCallback(() => {
    if (!enabled) return;

    let width = window.innerWidth;
    const height = window.innerHeight;

    // [临时诊断] 最小化/恢复验证：记录每次 resize 的原始值、document.hidden 状态、
    // 以及是否触发 isCompact 翻转。确认后删除本块。
    // eslint-disable-next-line no-console
    console.log(
      '[DiagResize]',
      JSON.stringify({
        t: new Date().toISOString().slice(17, 23),
        rawWidth: window.innerWidth,
        rawHeight: window.innerHeight,
        hidden: document.hidden,
        prevWidth: windowSizeRef.current.width,
        wouldFlipCompact: window.innerWidth < compactThreshold,
        prevIsCompact: windowSizeRef.current.isCompact,
      }),
    );

    // 窗口最小化/隐藏时，WebView2 可能报告极小或 0 宽度，
    // 导致 isCompact 误翻转 → CenterStage 卸载 → BrowserPanel 销毁 WebView → 恢复后重新加载。
    // document.hidden 为 true 时跳过更新，保留恢复前的有效尺寸。
    if (document.hidden) {
      return;
    }
    // 兜底：窗口恢复瞬间也可能短暂报告 0 宽度，忽略这样的瞬态值
    if (width <= 0) {
      width = windowSizeRef.current.width;
    }

    setWindowSize(() => {
      const next: WindowSizeInfo = {
        width,
        height,
        isCompact: width < compactThreshold,
      };
      windowSizeRef.current = next;
      return next;
    });
  }, [compactThreshold, enabled]);

  useEffect(() => {
    if (!enabled) return;

    // 初始化
    handleResize();

    // 监听窗口尺寸变化
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [handleResize, enabled]);

  return windowSize;
}
