/**
 * 错误处理 Hook
 * 
 * 提供统一的错误处理机制，包括错误状态管理和恢复策略
 */

import { useCallback, useState } from 'react';
import {
  AppError,
  ErrorRecovery,
  ErrorSeverity,
  ErrorSource,
  errorLogger,
  isRecoverable,
  needsUserAction,
  toAppError,
} from '@/types/errors';

/**
 * 错误状态接口
 */
export interface ErrorState {
  /** 当前错误 */
  error: AppError | null;
  /** 是否有错误 */
  hasError: boolean;
  /** 用户友好的错误消息 */
  message: string;
  /** 是否可恢复 */
  isRecoverable: boolean;
  /** 是否需要用户干预 */
  needsUserAction: boolean;
  /** 恢复策略 */
  recovery: ErrorRecovery;
}

/**
 * useError Hook 返回类型
 */
export interface UseErrorReturn extends ErrorState {
  /** 设置错误 */
  setError: (error: unknown, options?: ErrorOptions) => void;
  /** 清除错误 */
  clearError: () => void;
  /** 处理异步操作错误 */
  withErrorHandling: <T>(
    fn: () => Promise<T>,
    options?: ErrorOptions
  ) => Promise<T | null>;
  /** 执行恢复策略 */
  recover: () => void;
}

/**
 * 错误选项
 */
export interface ErrorOptions {
  /** 错误来源 */
  source?: ErrorSource;
  /** 错误严重级别 */
  severity?: ErrorSeverity;
  /** 错误代码 */
  code?: string;
  /** 上下文数据 */
  context?: Record<string, unknown>;
}

/**
 * 错误处理 Hook
 * 
 * @example
 * ```tsx
 * const { error, hasError, setError, clearError, withErrorHandling } = useError();
 * 
 * // 直接设置错误
 * setError(new Error('操作失败'));
 * 
 * // 处理异步操作
 * const result = await withErrorHandling(
 *   () => fetchData(),
 *   { source: ErrorSource.Network }
 * );
 * 
 * // 渲染错误状态
 * if (hasError) {
 *   return <div>{message}</div>;
 * }
 * ```
 */
export function useError(): UseErrorReturn {
  const [state, setState] = useState<ErrorState>({
    error: null,
    hasError: false,
    message: '',
    isRecoverable: true,
    needsUserAction: false,
    recovery: ErrorRecovery.None,
  });

  const setError = useCallback((error: unknown, options?: ErrorOptions) => {
    const appError = toAppError(error, options);
    
    // 记录错误日志
    errorLogger.log(appError);
    
    setState({
      error: appError,
      hasError: true,
      message: appError.getUserMessage(),
      isRecoverable: isRecoverable(appError),
      needsUserAction: needsUserAction(appError),
      recovery: appError.recovery,
    });
  }, []);

  const clearError = useCallback(() => {
    setState({
      error: null,
      hasError: false,
      message: '',
      isRecoverable: true,
      needsUserAction: false,
      recovery: ErrorRecovery.None,
    });
  }, []);

  const withErrorHandling = useCallback(
    async <T,>(
      fn: () => Promise<T>,
      options?: ErrorOptions
    ): Promise<T | null> => {
      try {
        const result = await fn();
        return result;
      } catch (error) {
        setError(error, options);
        return null;
      }
    },
    [setError]
  );

  const recover = useCallback(() => {
    if (!state.error) return;

    switch (state.error.recovery) {
      case ErrorRecovery.Retry:
        // 由调用方实现重试逻辑
        clearError();
        break;
      case ErrorRecovery.Reload:
        window.location.reload();
        break;
      case ErrorRecovery.Reset:
        clearError();
        break;
      case ErrorRecovery.Fallback:
        clearError();
        break;
      case ErrorRecovery.UserAction:
        // 需要用户干预，不自动恢复
        break;
      default:
        clearError();
    }
  }, [state.error, clearError]);

  return {
    ...state,
    setError,
    clearError,
    withErrorHandling,
    recover,
  };
}

/**
 * 全局异步错误处理 Hook
 * 
 * 用于捕获未处理的 Promise rejection
 */
export function useGlobalErrorHandler(): void {
  // 处理未捕获的 Promise rejection
  const handleRejection = useCallback((event: PromiseRejectionEvent) => {
    const error = toAppError(event.reason, {
      source: ErrorSource.Unknown,
      severity: ErrorSeverity.Error,
    });
    
    errorLogger.log(error);
    
    // 阻止默认行为
    event.preventDefault();
  }, []);

  // 处理未捕获的错误
  const handleError = useCallback((event: ErrorEvent) => {
    const error = toAppError(event.error, {
      source: ErrorSource.Render,
      severity: ErrorSeverity.Critical,
    });
    
    errorLogger.log(error);
    
    // 对于渲染错误，让 ErrorBoundary 处理
    if (error.source === ErrorSource.Render) {
      return;
    }
    
    event.preventDefault();
  }, []);

  // 设置全局错误处理器
  if (typeof window !== 'undefined') {
    window.addEventListener('unhandledrejection', handleRejection);
    window.addEventListener('error', handleError);
  }
}

/**
 * Store 错误状态标准化工具
 * 
 * 用于 Zustand store 的错误状态管理
 */
export interface StoreErrorState {
  error: string | null;
  isLoading: boolean;
}

export interface StoreErrorActions {
  setError: (error: unknown) => void;
  clearError: () => void;
}

/**
 * 创建 store 错误状态切片
 */
export function createErrorSlice<State extends StoreErrorState>() {
  return {
    error: null as string | null,
    isLoading: false,
    
    setError: function (this: State, error: unknown) {
      const appError = toAppError(error);
      errorLogger.log(appError);
      this.error = appError.message;
    },
    
    clearError: function (this: State) {
      this.error = null;
    },
  };
}

/**
 * 安全执行异步操作的工具函数
 */
export async function safeAsync<T>(
  fn: () => Promise<T>,
  options?: {
    onError?: (error: AppError) => void;
    source?: ErrorSource;
    context?: Record<string, unknown>;
  }
): Promise<{ data: T | null; error: AppError | null }> {
  try {
    const data = await fn();
    return { data, error: null };
  } catch (e) {
    const error = toAppError(e, {
      source: options?.source,
      context: options?.context,
    });
    
    errorLogger.log(error);
    
    if (options?.onError) {
      options.onError(error);
    }
    
    return { data: null, error };
  }
}
