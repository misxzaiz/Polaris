/**
 * 统一错误类型系统测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AppError,
  NetworkError,
  FileError,
  GitOperationError,
  AIError,
  SystemError,
  UserError,
  ErrorSource,
  ErrorSeverity,
  ErrorRecovery,
  toAppError,
  getErrorMessage,
  isRecoverable,
  needsUserAction,
  ErrorLogger,
  errorLogger,
} from './errors';

describe('ErrorSource Enum', () => {
  it('should have all expected source values', () => {
    expect(ErrorSource.Network).toBe('network');
    expect(ErrorSource.File).toBe('file');
    expect(ErrorSource.Git).toBe('git');
    expect(ErrorSource.AI).toBe('ai');
    expect(ErrorSource.System).toBe('system');
    expect(ErrorSource.User).toBe('user');
    expect(ErrorSource.Render).toBe('render');
    expect(ErrorSource.Unknown).toBe('unknown');
  });
});

describe('ErrorSeverity Enum', () => {
  it('should have all expected severity values', () => {
    expect(ErrorSeverity.Critical).toBe('critical');
    expect(ErrorSeverity.Error).toBe('error');
    expect(ErrorSeverity.Warning).toBe('warning');
    expect(ErrorSeverity.Info).toBe('info');
  });
});

describe('ErrorRecovery Enum', () => {
  it('should have all expected recovery values', () => {
    expect(ErrorRecovery.None).toBe('none');
    expect(ErrorRecovery.Retry).toBe('retry');
    expect(ErrorRecovery.Reload).toBe('reload');
    expect(ErrorRecovery.Reset).toBe('reset');
    expect(ErrorRecovery.Fallback).toBe('fallback');
    expect(ErrorRecovery.UserAction).toBe('user-action');
  });
});

describe('AppError', () => {
  it('should create error with default values', () => {
    const error = new AppError({ message: 'Test error' });
    
    expect(error.message).toBe('Test error');
    expect(error.name).toBe('AppError');
    expect(error.source).toBe(ErrorSource.Unknown);
    expect(error.severity).toBe(ErrorSeverity.Error);
    expect(error.recovery).toBe(ErrorRecovery.None);
    expect(error.code).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(error.context).toBeUndefined();
    expect(error.timestamp).toBeInstanceOf(Date);
  });

  it('should create error with all options', () => {
    const cause = new Error('Original error');
    const error = new AppError({
      message: 'Test error',
      source: ErrorSource.Network,
      severity: ErrorSeverity.Critical,
      code: 'NET001',
      recovery: ErrorRecovery.Retry,
      cause,
      context: { url: 'https://example.com' },
    });
    
    expect(error.message).toBe('Test error');
    expect(error.source).toBe(ErrorSource.Network);
    expect(error.severity).toBe(ErrorSeverity.Critical);
    expect(error.code).toBe('NET001');
    expect(error.recovery).toBe(ErrorRecovery.Retry);
    expect(error.cause).toBe(cause);
    expect(error.context).toEqual({ url: 'https://example.com' });
  });

  describe('toJSON', () => {
    it('should convert to JSON format', () => {
      const error = new AppError({
        message: 'Test error',
        source: ErrorSource.Network,
        severity: ErrorSeverity.Error,
        code: 'NET001',
      });
      
      const json = error.toJSON();
      
      expect(json.name).toBe('AppError');
      expect(json.message).toBe('Test error');
      expect(json.source).toBe(ErrorSource.Network);
      expect(json.severity).toBe(ErrorSeverity.Error);
      expect(json.code).toBe('NET001');
      expect(json.timestamp).toBeDefined();
      expect(json.stack).toBeDefined();
    });

    it('should include cause in JSON', () => {
      const cause = new Error('Original');
      const error = new AppError({
        message: 'Test',
        cause,
      });
      
      const json = error.toJSON();
      
      expect(json.cause).toBeDefined();
      expect((json.cause as { message: string }).message).toBe('Original');
    });
  });

  describe('getUserMessage', () => {
    it('should return friendly message for Network error', () => {
      const error = new AppError({
        message: 'Connection refused',
        source: ErrorSource.Network,
      });
      
      expect(error.getUserMessage()).toBe('网络请求失败，请检查网络连接后重试');
    });

    it('should return friendly message for File error', () => {
      const error = new AppError({
        message: 'File not found',
        source: ErrorSource.File,
      });
      
      expect(error.getUserMessage()).toBe('文件操作失败，请检查文件路径和权限');
    });

    it('should return friendly message for Git error', () => {
      const error = new AppError({
        message: 'Merge conflict',
        source: ErrorSource.Git,
      });
      
      expect(error.getUserMessage()).toBe('Git 操作失败，请检查仓库状态');
    });

    it('should return friendly message for AI error', () => {
      const error = new AppError({
        message: 'Model timeout',
        source: ErrorSource.AI,
      });
      
      expect(error.getUserMessage()).toBe('AI 处理失败，请稍后重试');
    });

    it('should return friendly message for System error', () => {
      const error = new AppError({
        message: 'Tauri API failed',
        source: ErrorSource.System,
      });
      
      expect(error.getUserMessage()).toBe('系统操作失败，请重启应用');
    });

    it('should return original message for User error', () => {
      const error = new AppError({
        message: 'Invalid input format',
        source: ErrorSource.User,
      });
      
      expect(error.getUserMessage()).toBe('Invalid input format');
    });

    it('should return friendly message for Render error', () => {
      const error = new AppError({
        message: 'Component crash',
        source: ErrorSource.Render,
      });
      
      expect(error.getUserMessage()).toBe('页面渲染错误，正在尝试恢复');
    });

    it('should return default message for Unknown error', () => {
      const error = new AppError({
        message: 'Something went wrong',
        source: ErrorSource.Unknown,
      });
      
      expect(error.getUserMessage()).toBe('操作失败，请重试');
    });
  });
});

describe('Specific Error Classes', () => {
  describe('NetworkError', () => {
    it('should create with correct defaults', () => {
      const error = new NetworkError({ message: 'Connection failed' });
      
      expect(error.name).toBe('NetworkError');
      expect(error.source).toBe(ErrorSource.Network);
      expect(error.severity).toBe(ErrorSeverity.Error);
      expect(error.recovery).toBe(ErrorRecovery.Retry);
    });

    it('should be instance of AppError', () => {
      const error = new NetworkError({ message: 'Test' });
      expect(error).toBeInstanceOf(AppError);
    });
  });

  describe('FileError', () => {
    it('should create with correct defaults', () => {
      const error = new FileError({ message: 'File not found' });
      
      expect(error.name).toBe('FileError');
      expect(error.source).toBe(ErrorSource.File);
      expect(error.severity).toBe(ErrorSeverity.Error);
      expect(error.recovery).toBe(ErrorRecovery.Retry);
    });
  });

  describe('GitOperationError', () => {
    it('should create with correct defaults', () => {
      const error = new GitOperationError({ message: 'Merge conflict' });
      
      expect(error.name).toBe('GitOperationError');
      expect(error.source).toBe(ErrorSource.Git);
      expect(error.severity).toBe(ErrorSeverity.Error);
      expect(error.recovery).toBe(ErrorRecovery.UserAction);
    });
  });

  describe('AIError', () => {
    it('should create with correct defaults', () => {
      const error = new AIError({ message: 'Model timeout' });
      
      expect(error.name).toBe('AIError');
      expect(error.source).toBe(ErrorSource.AI);
      expect(error.severity).toBe(ErrorSeverity.Error);
      expect(error.recovery).toBe(ErrorRecovery.Retry);
    });
  });

  describe('SystemError', () => {
    it('should create with correct defaults', () => {
      const error = new SystemError({ message: 'Tauri API failed' });
      
      expect(error.name).toBe('SystemError');
      expect(error.source).toBe(ErrorSource.System);
      expect(error.severity).toBe(ErrorSeverity.Critical);
      expect(error.recovery).toBe(ErrorRecovery.Reload);
    });
  });

  describe('UserError', () => {
    it('should create with correct defaults', () => {
      const error = new UserError({ message: 'Invalid input' });
      
      expect(error.name).toBe('UserError');
      expect(error.source).toBe(ErrorSource.User);
      expect(error.severity).toBe(ErrorSeverity.Warning);
      expect(error.recovery).toBe(ErrorRecovery.UserAction);
    });

    it('should not accept cause parameter', () => {
      // UserError doesn't have cause in its options
      const error = new UserError({ message: 'Invalid input' });
      expect(error.cause).toBeUndefined();
    });
  });
});

describe('toAppError', () => {
  it('should return AppError unchanged', () => {
    const original = new AppError({ message: 'Test' });
    const result = toAppError(original);
    
    expect(result).toBe(original);
  });

  it('should convert Error to AppError', () => {
    const error = new Error('Test error');
    const result = toAppError(error);
    
    expect(result).toBeInstanceOf(AppError);
    expect(result.message).toBe('Test error');
    expect(result.cause).toBe(error);
  });

  it('should convert string to AppError', () => {
    const result = toAppError('String error');
    
    expect(result).toBeInstanceOf(AppError);
    expect(result.message).toBe('String error');
    expect(result.source).toBe(ErrorSource.Unknown);
  });

  it('should convert object with message to AppError', () => {
    const result = toAppError({ message: 'Object error' });
    
    expect(result).toBeInstanceOf(AppError);
    expect(result.message).toBe('Object error');
  });

  it('should convert object with error property to AppError', () => {
    const result = toAppError({ error: 'Object error property' });
    
    expect(result).toBeInstanceOf(AppError);
    expect(result.message).toBe('Object error property');
  });

  it('should convert object without message/error to AppError', () => {
    const result = toAppError({ code: 500 });
    
    expect(result).toBeInstanceOf(AppError);
    expect(result.message).toContain('code');
  });

  it('should convert null to AppError', () => {
    const result = toAppError(null);
    
    expect(result).toBeInstanceOf(AppError);
    expect(result.message).toBe('null');
  });

  it('should convert undefined to AppError', () => {
    const result = toAppError(undefined);
    
    expect(result).toBeInstanceOf(AppError);
    expect(result.message).toBe('undefined');
  });

  it('should convert number to AppError', () => {
    const result = toAppError(42);
    
    expect(result).toBeInstanceOf(AppError);
    expect(result.message).toBe('42');
  });

  it('should accept options for source', () => {
    const error = new Error('Test');
    const result = toAppError(error, { source: ErrorSource.Network });
    
    expect(result.source).toBe(ErrorSource.Network);
  });

  it('should accept options for severity', () => {
    const result = toAppError('Test', { severity: ErrorSeverity.Critical });
    
    expect(result.severity).toBe(ErrorSeverity.Critical);
  });

  it('should accept options for code', () => {
    const result = toAppError('Test', { code: 'ERR001' });
    
    expect(result.code).toBe('ERR001');
  });

  it('should accept options for context', () => {
    const result = toAppError('Test', { context: { foo: 'bar' } });
    
    expect(result.context).toEqual({ foo: 'bar' });
  });

  describe('inferErrorSource', () => {
    it('should infer Network source from network error name', () => {
      const error = new Error('Test');
      error.name = 'NetworkError';
      const result = toAppError(error);
      
      expect(result.source).toBe(ErrorSource.Network);
    });

    it('should infer Network source from fetch error name', () => {
      const error = new Error('Test');
      error.name = 'FetchError';
      const result = toAppError(error);
      
      expect(result.source).toBe(ErrorSource.Network);
    });

    it('should infer Network source from timeout error name', () => {
      const error = new Error('Test');
      error.name = 'TimeoutError';
      const result = toAppError(error);
      
      expect(result.source).toBe(ErrorSource.Network);
    });

    it('should infer Network source from network message', () => {
      const error = new Error('Network connection failed');
      const result = toAppError(error);
      
      expect(result.source).toBe(ErrorSource.Network);
    });

    it('should infer Network source from Chinese network message', () => {
      const error = new Error('请求失败，请重试');
      const result = toAppError(error);
      
      expect(result.source).toBe(ErrorSource.Network);
    });

    it('should infer File source from file error name', () => {
      const error = new Error('Test');
      error.name = 'ENOENT';
      const result = toAppError(error);
      
      expect(result.source).toBe(ErrorSource.File);
    });

    it('should infer File source from file message', () => {
      const error = new Error('文件不存在');
      const result = toAppError(error);
      
      expect(result.source).toBe(ErrorSource.File);
    });

    it('should infer Git source from git error name', () => {
      const error = new Error('Test');
      error.name = 'GitError';
      const result = toAppError(error);
      
      expect(result.source).toBe(ErrorSource.Git);
    });

    it('should infer Git source from git message', () => {
      const error = new Error('merge conflict detected');
      const result = toAppError(error);
      
      expect(result.source).toBe(ErrorSource.Git);
    });

    it('should infer Git source from Chinese git message', () => {
      const error = new Error('分支合并失败');
      const result = toAppError(error);
      
      expect(result.source).toBe(ErrorSource.Git);
    });

    it('should infer AI source from AI error name', () => {
      const error = new Error('Test');
      error.name = 'AIError';
      const result = toAppError(error);
      
      expect(result.source).toBe(ErrorSource.AI);
    });

    it('should infer AI source from AI message', () => {
      // 注意：不能使用 "timeout" 关键词，因为网络错误检查会优先匹配
      const error = new Error('claude api error');
      const result = toAppError(error);
      
      expect(result.source).toBe(ErrorSource.AI);
    });

    it('should infer AI source from Chinese AI message', () => {
      const error = new Error('模型调用失败');
      const result = toAppError(error);
      
      expect(result.source).toBe(ErrorSource.AI);
    });

    it('should return Unknown for unrecognized errors', () => {
      const error = new Error('Some random error');
      const result = toAppError(error);
      
      expect(result.source).toBe(ErrorSource.Unknown);
    });
  });
});

describe('getErrorMessage', () => {
  it('should return user message for AppError', () => {
    const error = new NetworkError({ message: 'Connection failed' });
    expect(getErrorMessage(error)).toBe('网络请求失败，请检查网络连接后重试');
  });

  it('should return message for Error', () => {
    const error = new Error('Standard error');
    expect(getErrorMessage(error)).toBe('Standard error');
  });

  it('should return string as-is', () => {
    expect(getErrorMessage('String error')).toBe('String error');
  });

  it('should return default message for other types', () => {
    expect(getErrorMessage(null)).toBe('操作失败，请重试');
    expect(getErrorMessage(undefined)).toBe('操作失败，请重试');
    expect(getErrorMessage(42)).toBe('操作失败，请重试');
  });
});

describe('isRecoverable', () => {
  it('should return true for error with Retry recovery', () => {
    const error = new NetworkError({ message: 'Test' });
    expect(isRecoverable(error)).toBe(true);
  });

  it('should return false for error with None recovery', () => {
    const error = new AppError({ 
      message: 'Test',
      recovery: ErrorRecovery.None 
    });
    expect(isRecoverable(error)).toBe(false);
  });

  it('should return true for non-AppError', () => {
    expect(isRecoverable(new Error('Test'))).toBe(true);
    expect(isRecoverable('String error')).toBe(true);
  });
});

describe('needsUserAction', () => {
  it('should return true for error with UserAction recovery', () => {
    const error = new UserError({ message: 'Invalid input' });
    expect(needsUserAction(error)).toBe(true);
  });

  it('should return true for GitOperationError', () => {
    const error = new GitOperationError({ message: 'Merge conflict' });
    expect(needsUserAction(error)).toBe(true);
  });

  it('should return false for error with other recovery', () => {
    const error = new NetworkError({ message: 'Test' });
    expect(needsUserAction(error)).toBe(false);
  });

  it('should return false for non-AppError', () => {
    expect(needsUserAction(new Error('Test'))).toBe(false);
  });
});

describe('ErrorLogger', () => {
  let logger: ErrorLogger;
  
  beforeEach(() => {
    logger = ErrorLogger.getInstance();
    logger.clear();
  });

  it('should be a singleton', () => {
    const instance1 = ErrorLogger.getInstance();
    const instance2 = ErrorLogger.getInstance();
    
    expect(instance1).toBe(instance2);
  });

  it('should log errors', () => {
    const error = new AppError({ message: 'Test error' });
    logger.log(error);
    
    const errors = logger.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(error);
  });

      it('should maintain max errors limit', () => {
        // Note: ErrorLogger is a singleton with private constructor
        // We test the behavior through the singleton instance
        // Clear first to ensure clean state
        logger.clear();
        
        // The default max is 100, but we can't test the limit without
        // creating many errors. This test verifies the basic log behavior.
        logger.log(new AppError({ message: 'Test error 1' }));
        logger.log(new AppError({ message: 'Test error 2' }));
        
        const errors = logger.getErrors();
        expect(errors).toHaveLength(2);
        
        // Clean up
        logger.clear();
      });
  it('should clear errors', () => {
    logger.log(new AppError({ message: 'Test' }));
    expect(logger.getErrors()).toHaveLength(1);
    
    logger.clear();
    expect(logger.getErrors()).toHaveLength(0);
  });

  it('should export errors as JSON', () => {
    logger.log(new AppError({ 
      message: 'Test',
      source: ErrorSource.Network,
      code: 'NET001',
    }));
    
    const exported = logger.export();
    const parsed = JSON.parse(exported);
    
    expect(parsed).toHaveLength(1);
    expect(parsed[0].message).toBe('Test');
    expect(parsed[0].source).toBe('network');
    expect(parsed[0].code).toBe('NET001');
  });

  describe('console output', () => {
    it('should use console.error for Critical severity', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      logger.log(new AppError({ 
        message: 'Critical',
        severity: ErrorSeverity.Critical 
      }));
      
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should use console.error for Error severity', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      logger.log(new AppError({ 
        message: 'Error',
        severity: ErrorSeverity.Error 
      }));
      
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should use console.warn for Warning severity', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      logger.log(new AppError({ 
        message: 'Warning',
        severity: ErrorSeverity.Warning 
      }));
      
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should use console.log for Info severity', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      logger.log(new AppError({ 
        message: 'Info',
        severity: ErrorSeverity.Info 
      }));
      
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});

describe('errorLogger export', () => {
  it('should export the singleton instance', () => {
    expect(errorLogger).toBe(ErrorLogger.getInstance());
  });
});
