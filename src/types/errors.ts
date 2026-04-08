/**
 * 统一错误类型系统
 * 
 * 提供标准化的错误分类、错误处理和错误恢复策略
 */

// ============================================================================
// 错误类型枚举
// ============================================================================

/**
 * 错误来源类型
 */
export enum ErrorSource {
  /** 网络请求错误 */
  Network = 'network',
  /** 文件系统操作错误 */
  File = 'file',
  /** Git 操作错误 */
  Git = 'git',
  /** AI 引擎错误 */
  AI = 'ai',
  /** 系统级错误 (Tauri API 等) */
  System = 'system',
  /** 用户输入错误 */
  User = 'user',
  /** 渲染错误 */
  Render = 'render',
  /** 未知错误 */
  Unknown = 'unknown',
}

/**
 * 错误严重级别
 */
export enum ErrorSeverity {
  /** 致命错误 - 应用无法继续运行 */
  Critical = 'critical',
  /** 错误 - 功能失败但应用可继续 */
  Error = 'error',
  /** 警告 - 可能影响功能但非致命 */
  Warning = 'warning',
  /** 信息 - 仅供调试 */
  Info = 'info',
}

/**
 * 错误恢复策略
 */
export enum ErrorRecovery {
  /** 无需恢复 - 自动处理 */
  None = 'none',
  /** 重试操作 */
  Retry = 'retry',
  /** 刷新页面 */
  Reload = 'reload',
  /** 重置状态 */
  Reset = 'reset',
  /** 显示错误页面 */
  Fallback = 'fallback',
  /** 用户干预 */
  UserAction = 'user-action',
}

// ============================================================================
// 应用错误类
// ============================================================================

/**
 * 应用统一错误类
 * 
 * 所有应用错误应使用此类或其子类，确保错误信息标准化
 */
export class AppError extends Error {
  /** 错误来源 */
  readonly source: ErrorSource;
  /** 错误严重级别 */
  readonly severity: ErrorSeverity;
  /** 错误代码 */
  readonly code?: string;
  /** 恢复策略 */
  readonly recovery: ErrorRecovery;
  /** 原始错误 */
  readonly cause?: Error;
  /** 时间戳 */
  readonly timestamp: Date;
  /** 上下文数据 */
  readonly context?: Record<string, unknown>;

  constructor(options: {
    message: string;
    source?: ErrorSource;
    severity?: ErrorSeverity;
    code?: string;
    recovery?: ErrorRecovery;
    cause?: Error;
    context?: Record<string, unknown>;
  }) {
    super(options.message);
    this.name = 'AppError';
    this.source = options.source ?? ErrorSource.Unknown;
    this.severity = options.severity ?? ErrorSeverity.Error;
    this.code = options.code;
    this.recovery = options.recovery ?? ErrorRecovery.None;
    this.cause = options.cause;
    this.timestamp = new Date();
    this.context = options.context;

    // 保持正确的原型链
    Object.setPrototypeOf(this, AppError.prototype);
  }

  /**
   * 转换为 JSON 格式（用于日志和上报）
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      source: this.source,
      severity: this.severity,
      code: this.code,
      recovery: this.recovery,
      timestamp: this.timestamp.toISOString(),
      context: this.context,
      cause: this.cause
        ? {
            name: this.cause.name,
            message: this.cause.message,
            stack: this.cause.stack,
          }
        : undefined,
      stack: this.stack,
    };
  }

  /**
   * 获取用户友好的错误消息
   */
  getUserMessage(): string {
    // 根据错误来源返回友好消息
    switch (this.source) {
      case ErrorSource.Network:
        return '网络请求失败，请检查网络连接后重试';
      case ErrorSource.File:
        return '文件操作失败，请检查文件路径和权限';
      case ErrorSource.Git:
        return 'Git 操作失败，请检查仓库状态';
      case ErrorSource.AI:
        return 'AI 处理失败，请稍后重试';
      case ErrorSource.System:
        return '系统操作失败，请重启应用';
      case ErrorSource.User:
        return this.message; // 用户错误直接显示
      case ErrorSource.Render:
        return '页面渲染错误，正在尝试恢复';
      default:
        return '操作失败，请重试';
    }
  }
}

// ============================================================================
// 特定错误类
// ============================================================================

/**
 * 网络错误
 */
export class NetworkError extends AppError {
  constructor(options: {
    message: string;
    code?: string;
    cause?: Error;
    context?: Record<string, unknown>;
  }) {
    super({
      ...options,
      source: ErrorSource.Network,
      severity: ErrorSeverity.Error,
      recovery: ErrorRecovery.Retry,
    });
    this.name = 'NetworkError';
    Object.setPrototypeOf(this, NetworkError.prototype);
  }
}

/**
 * 文件错误
 */
export class FileError extends AppError {
  constructor(options: {
    message: string;
    code?: string;
    cause?: Error;
    context?: Record<string, unknown>;
  }) {
    super({
      ...options,
      source: ErrorSource.File,
      severity: ErrorSeverity.Error,
      recovery: ErrorRecovery.Retry,
    });
    this.name = 'FileError';
    Object.setPrototypeOf(this, FileError.prototype);
  }
}

/**
 * Git 操作错误
 * 注意：命名为 GitOperationError 以避免与 types/git.ts 中的 GitError 接口冲突
 */
export class GitOperationError extends AppError {
  constructor(options: {
    message: string;
    code?: string;
    cause?: Error;
    context?: Record<string, unknown>;
  }) {
    super({
      ...options,
      source: ErrorSource.Git,
      severity: ErrorSeverity.Error,
      recovery: ErrorRecovery.UserAction,
    });
    this.name = 'GitOperationError';
    Object.setPrototypeOf(this, GitOperationError.prototype);
  }
}

/**
 * AI 引擎错误
 */
export class AIError extends AppError {
  constructor(options: {
    message: string;
    code?: string;
    cause?: Error;
    context?: Record<string, unknown>;
  }) {
    super({
      ...options,
      source: ErrorSource.AI,
      severity: ErrorSeverity.Error,
      recovery: ErrorRecovery.Retry,
    });
    this.name = 'AIError';
    Object.setPrototypeOf(this, AIError.prototype);
  }
}

/**
 * 系统错误
 */
export class SystemError extends AppError {
  constructor(options: {
    message: string;
    code?: string;
    cause?: Error;
    context?: Record<string, unknown>;
  }) {
    super({
      ...options,
      source: ErrorSource.System,
      severity: ErrorSeverity.Critical,
      recovery: ErrorRecovery.Reload,
    });
    this.name = 'SystemError';
    Object.setPrototypeOf(this, SystemError.prototype);
  }
}

/**
 * 用户输入错误
 */
export class UserError extends AppError {
  constructor(options: {
    message: string;
    code?: string;
    context?: Record<string, unknown>;
  }) {
    super({
      ...options,
      source: ErrorSource.User,
      severity: ErrorSeverity.Warning,
      recovery: ErrorRecovery.UserAction,
    });
    this.name = 'UserError';
    Object.setPrototypeOf(this, UserError.prototype);
  }
}

// ============================================================================
// 错误处理工具函数
// ============================================================================

/**
 * 将未知错误转换为 AppError
 */
export function toAppError(
  error: unknown,
  options?: {
    source?: ErrorSource;
    severity?: ErrorSeverity;
    code?: string;
    context?: Record<string, unknown>;
  }
): AppError {
  // 已经是 AppError
  if (error instanceof AppError) {
    return error;
  }

  // 标准 Error 对象
  if (error instanceof Error) {
    // 根据错误消息特征推断来源
    const source = inferErrorSource(error);
    
    return new AppError({
      message: error.message,
      source: options?.source ?? source,
      severity: options?.severity ?? ErrorSeverity.Error,
      code: options?.code,
      cause: error,
      context: options?.context,
    });
  }

  // 字符串错误
  if (typeof error === 'string') {
    return new AppError({
      message: error,
      source: options?.source ?? ErrorSource.Unknown,
      severity: options?.severity ?? ErrorSeverity.Error,
      code: options?.code,
      context: options?.context,
    });
  }

  // 对象错误
  if (typeof error === 'object' && error !== null) {
    const errorObj = error as Record<string, unknown>;
    const message = 
      (errorObj.message as string) ?? 
      (errorObj.error as string) ?? 
      JSON.stringify(error);
    
    return new AppError({
      message,
      source: options?.source ?? ErrorSource.Unknown,
      severity: options?.severity ?? ErrorSeverity.Error,
      code: options?.code,
      context: options?.context,
    });
  }

  // 其他情况
  return new AppError({
    message: String(error),
    source: options?.source ?? ErrorSource.Unknown,
    severity: options?.severity ?? ErrorSeverity.Error,
    code: options?.code,
    context: options?.context,
  });
}

/**
 * 根据错误特征推断错误来源
 */
function inferErrorSource(error: Error): ErrorSource {
  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  // 网络错误特征
  if (
    name.includes('network') ||
    name.includes('fetch') ||
    name.includes('timeout') ||
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('timeout') ||
    message.includes('请求失败') ||
    message.includes('连接')
  ) {
    return ErrorSource.Network;
  }

  // 文件错误特征
  if (
    name.includes('file') ||
    name.includes('enoent') ||
    message.includes('file') ||
    message.includes('文件') ||
    message.includes('路径') ||
    message.includes('path')
  ) {
    return ErrorSource.File;
  }

  // Git 错误特征
  if (
    name.includes('git') ||
    message.includes('git') ||
    message.includes('分支') ||
    message.includes('提交') ||
    message.includes('冲突') ||
    message.includes('merge') ||
    message.includes('branch') ||
    message.includes('commit')
  ) {
    return ErrorSource.Git;
  }

  // AI 错误特征
  if (
    name.includes('ai') ||
    name.includes('llm') ||
    message.includes('ai') ||
    message.includes('模型') ||
    message.includes('token') ||
    message.includes('claude')
  ) {
    return ErrorSource.AI;
  }

  return ErrorSource.Unknown;
}

/**
 * 获取错误的用户友好消息
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.getUserMessage();
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return '操作失败，请重试';
}

/**
 * 判断错误是否可恢复
 */
export function isRecoverable(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.recovery !== ErrorRecovery.None;
  }
  return true; // 默认可恢复
}

/**
 * 判断错误是否需要用户干预
 */
export function needsUserAction(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.recovery === ErrorRecovery.UserAction;
  }
  return false;
}

// ============================================================================
// 错误日志工具
// ============================================================================

/**
 * 错误日志记录器
 */
export class ErrorLogger {
  private static instance: ErrorLogger;
  private errors: AppError[] = [];
  private maxErrors = 20;

  private constructor() {}

  static getInstance(): ErrorLogger {
    if (!ErrorLogger.instance) {
      ErrorLogger.instance = new ErrorLogger();
    }
    return ErrorLogger.instance;
  }

  /**
   * 记录错误
   */
  log(error: AppError): void {
    this.errors.push(error);
    
    // 保持最大数量
    if (this.errors.length > this.maxErrors) {
      this.errors.shift();
    }

    // 控制台输出
    const logMethod = 
      error.severity === ErrorSeverity.Critical ? 'error' :
      error.severity === ErrorSeverity.Error ? 'error' :
      error.severity === ErrorSeverity.Warning ? 'warn' : 'log';
    
    console[logMethod](`[${error.source}] ${error.message}`, {
      code: error.code,
      severity: error.severity,
      recovery: error.recovery,
      context: error.context,
      cause: error.cause,
    });
  }

  /**
   * 获取所有错误
   */
  getErrors(): AppError[] {
    return [...this.errors];
  }

  /**
   * 清除错误记录
   */
  clear(): void {
    this.errors = [];
  }

  /**
   * 导出错误日志（用于调试）
   */
  export(): string {
    return JSON.stringify(this.errors.map(e => e.toJSON()), null, 2);
  }
}

// 导出单例
export const errorLogger = ErrorLogger.getInstance();
