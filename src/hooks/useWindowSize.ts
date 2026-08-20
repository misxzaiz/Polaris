/**
 * 窗口尺寸监听 Hook
 *
 * 用于响应式布局，检测窗口尺寸变化并自动切换小屏模式
 */

import { useState, useEffect, useCallback } from 'react';

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

  const handleResize = useCallback(() => {
    if (!enabled) return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    setWindowSize({
      width,
      height,
      isCompact: width < compactThreshold,
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
