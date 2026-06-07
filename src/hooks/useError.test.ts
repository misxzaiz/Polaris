/**
 * 错误处理 Hook 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  AppError,
  NetworkError,
  UserError,
  SystemError,
  ErrorSource,
  ErrorSeverity,
  ErrorRecovery,
  errorLogger,
} from '@/types/errors';
import {
  useError,
  useGlobalErrorHandler,
  safeAsync,
  createErrorSlice,
} from './useError';

// Clear error logger before each test
beforeEach(() => {
  errorLogger.clear();
});

describe('useError', () => {
  describe('initial state', () => {
    it('should have correct initial state', () => {
      const { result } = renderHook(() => useError());
      
      expect(result.current.error).toBeNull();
      expect(result.current.hasError).toBe(false);
      expect(result.current.message).toBe('');
      expect(result.current.isRecoverable).toBe(true);
      expect(result.current.needsUserAction).toBe(false);
      expect(result.current.recovery).toBe(ErrorRecovery.None);
    });
  });

  describe('setError', () => {
    it('should set error from string', () => {
      const { result } = renderHook(() => useError());
      
      act(() => {
        result.current.setError('Test error');
      });
      
      expect(result.current.hasError).toBe(true);
      expect(result.current.error).toBeInstanceOf(AppError);
      expect(result.current.error?.message).toBe('Test error');
    });

    it('should set error from Error', () => {
      const { result } = renderHook(() => useError());
      
      act(() => {
        result.current.setError(new Error('Standard error'));
      });
      
      expect(result.current.hasError).toBe(true);
      expect(result.current.error).toBeInstanceOf(AppError);
      expect(result.current.error?.message).toBe('Standard error');
    });

    it('should set error from AppError', () => {
      const { result } = renderHook(() => useError());
      const appError = new NetworkError({ message: 'Network failed' });
      
      act(() => {
        result.current.setError(appError);
      });
      
      expect(result.current.hasError).toBe(true);
      expect(result.current.error).toBe(appError);
      expect(result.current.error?.source).toBe(ErrorSource.Network);
    });

    it('should set error with options', () => {
      const { result } = renderHook(() => useError());
      
      act(() => {
        result.current.setError('Test error', {
          source: ErrorSource.Network,
          severity: ErrorSeverity.Critical,
          code: 'NET001',
        });
      });
      
      expect(result.current.error?.source).toBe(ErrorSource.Network);
      expect(result.current.error?.severity).toBe(ErrorSeverity.Critical);
      expect(result.current.error?.code).toBe('NET001');
    });

    it('should update message from getUserMessage', () => {
      const { result } = renderHook(() => useError());

      act(() => {
        result.current.setError(new NetworkError({ message: 'Connection failed' }));
      });

      expect(result.current.message).toBe('errors:appError.network');
    });

    it('should update isRecoverable based on error', () => {
      const { result } = renderHook(() => useError());
      
      act(() => {
        result.current.setError(new NetworkError({ message: 'Test' }));
      });
      
      expect(result.current.isRecoverable).toBe(true);
    });

    it('should update needsUserAction based on error', () => {
      const { result } = renderHook(() => useError());
      
      act(() => {
        result.current.setError(new UserError({ message: 'Invalid input' }));
      });
      
      expect(result.current.needsUserAction).toBe(true);
    });
  });

  describe('clearError', () => {
    it('should clear error state', () => {
      const { result } = renderHook(() => useError());
      
      act(() => {
        result.current.setError('Test error');
      });
      
      expect(result.current.hasError).toBe(true);
      
      act(() => {
        result.current.clearError();
      });
      
      expect(result.current.error).toBeNull();
      expect(result.current.hasError).toBe(false);
      expect(result.current.message).toBe('');
      expect(result.current.isRecoverable).toBe(true);
      expect(result.current.needsUserAction).toBe(false);
      expect(result.current.recovery).toBe(ErrorRecovery.None);
    });
  });

  describe('withErrorHandling', () => {
    it('should return result on success', async () => {
      const { result } = renderHook(() => useError());
      
      let data: string | null = null;
      await act(async () => {
        data = await result.current.withErrorHandling(() => Promise.resolve('success'));
      });
      
      expect(data).toBe('success');
      expect(result.current.hasError).toBe(false);
    });

    it('should set error on failure', async () => {
      const { result } = renderHook(() => useError());
      
      let data: string | null = 'initial';
      await act(async () => {
        data = await result.current.withErrorHandling(
          () => Promise.reject(new Error('Async error'))
        );
      });
      
      expect(data).toBeNull();
      expect(result.current.hasError).toBe(true);
      expect(result.current.error?.message).toBe('Async error');
    });

    it('should pass options to error', async () => {
      const { result } = renderHook(() => useError());
      
      await act(async () => {
        await result.current.withErrorHandling(
          () => Promise.reject(new Error('Test')),
          { source: ErrorSource.AI }
        );
      });
      
      expect(result.current.error?.source).toBe(ErrorSource.AI);
    });
  });

  describe('recover', () => {
    it('should clear error on Retry recovery', () => {
      const { result } = renderHook(() => useError());
      
      act(() => {
        result.current.setError(new NetworkError({ message: 'Test' }));
      });
      
      expect(result.current.hasError).toBe(true);
      
      act(() => {
        result.current.recover();
      });
      
      expect(result.current.hasError).toBe(false);
    });

    it('should clear error on Reset recovery', () => {
      const { result } = renderHook(() => useError());
      
      act(() => {
        result.current.setError(new Error('Test'));
      });
      
      expect(result.current.hasError).toBe(true);
      
      act(() => {
        result.current.recover();
      });
      
      expect(result.current.hasError).toBe(false);
    });

    it('should not clear error on UserAction recovery', () => {
      const { result } = renderHook(() => useError());
      
      // Create a real UserError which has UserAction recovery
      act(() => {
        result.current.setError(new UserError({ message: 'Invalid input' }));
      });
      
      expect(result.current.hasError).toBe(true);
      expect(result.current.needsUserAction).toBe(true);
      
      act(() => {
        result.current.recover();
      });
      
      // UserAction recovery should not auto-clear
      expect(result.current.hasError).toBe(true);
    });

    it('should reload page on Reload recovery', () => {
      // Mock window.location.reload
      const originalLocation = window.location;
      const reloadMock = vi.fn();
      
      // Delete and redefine to avoid read-only issue
      // @ts-expect-error - mock for testing
      delete window.location;
      window.location = { reload: reloadMock } as Location;
      
      const { result } = renderHook(() => useError());
      
      act(() => {
        result.current.setError(new SystemError({ message: 'System error' }));
      });
      
      expect(result.current.hasError).toBe(true);
      
      act(() => {
        result.current.recover();
      });
      
      expect(reloadMock).toHaveBeenCalled();
      
      // Restore
      window.location = originalLocation;
    });

    it('should do nothing when no error', () => {
      const { result } = renderHook(() => useError());
      
      act(() => {
        result.current.recover();
      });
      
      expect(result.current.hasError).toBe(false);
    });
  });
});

describe('useGlobalErrorHandler', () => {
  it('should register event listeners', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    
    renderHook(() => useGlobalErrorHandler());
    
    expect(addEventListenerSpy).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));
    expect(addEventListenerSpy).toHaveBeenCalledWith('error', expect.any(Function));
    
    addEventListenerSpy.mockRestore();
  });
});

describe('createErrorSlice', () => {
  it('should create error slice with default values', () => {
    const slice = createErrorSlice();
    
    expect(slice.error).toBeNull();
    expect(slice.isLoading).toBe(false);
    expect(typeof slice.setError).toBe('function');
    expect(typeof slice.clearError).toBe('function');
  });

  it('should set error message', () => {
    const slice = createErrorSlice();
    const state = { ...slice };
    
    slice.setError.call(state, new Error('Test error'));
    
    expect(state.error).toBe('Test error');
  });

  it('should set error from string', () => {
    const slice = createErrorSlice();
    const state = { ...slice };
    
    slice.setError.call(state, 'String error');
    
    expect(state.error).toBe('String error');
  });

  it('should set error from AppError', () => {
    const slice = createErrorSlice();
    const state = { ...slice };
    
    slice.setError.call(state, new NetworkError({ message: 'Network failed' }));
    
    expect(state.error).toBe('Network failed');
  });

  it('should clear error', () => {
    const slice = createErrorSlice();
    const state = { ...slice, error: 'Test error' };
    
    slice.clearError.call(state);
    
    expect(state.error).toBeNull();
  });
});

describe('safeAsync', () => {
  it('should return data on success', async () => {
    const result = await safeAsync(() => Promise.resolve('success'));
    
    expect(result.data).toBe('success');
    expect(result.error).toBeNull();
  });

  it('should return error on failure', async () => {
    const result = await safeAsync(() => Promise.reject(new Error('Failed')));
    
    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(AppError);
    expect(result.error?.message).toBe('Failed');
  });

  it('should call onError callback on failure', async () => {
    const onError = vi.fn();
    
    await safeAsync(
      () => Promise.reject(new Error('Failed')),
      { onError }
    );
    
    expect(onError).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(AppError));
  });

  it('should pass source option to error', async () => {
    const result = await safeAsync(
      () => Promise.reject(new Error('Failed')),
      { source: ErrorSource.Network }
    );
    
    expect(result.error?.source).toBe(ErrorSource.Network);
  });

  it('should pass context option to error', async () => {
    const result = await safeAsync(
      () => Promise.reject(new Error('Failed')),
      { context: { url: 'https://example.com' } }
    );
    
    expect(result.error?.context).toEqual({ url: 'https://example.com' });
  });
});
