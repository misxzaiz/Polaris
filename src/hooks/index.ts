/**
 * Hooks 统一导出
 */

// 旧版 Hook（兼容性保留）
export { useChatEvent } from './useChat';

// 防抖/节流 Hooks
export { useDebounce, useDebouncedCallback } from './useDebounce';
export { useThrottle, useThrottledCallback } from './useThrottle';

// 响应式 Hooks
export { useWindowSize } from './useWindowSize';
export type { WindowSize, WindowSizeInfo, UseWindowSizeOptions } from './useWindowSize';
export { useContainerWidth } from './useContainerWidth';

// 错误处理 Hooks
export { useError, useGlobalErrorHandler, safeAsync } from './useError';
export type { ErrorState, UseErrorReturn, ErrorOptions, StoreErrorState, StoreErrorActions } from './useError';
