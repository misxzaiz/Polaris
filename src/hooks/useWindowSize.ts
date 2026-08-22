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

    // 窗口恢复/最小化/切换时，WebView2 可能短暂报告 0 宽度，
    // 忽略这样的瞬态值，避免触发小屏模式而关闭左侧面板
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
