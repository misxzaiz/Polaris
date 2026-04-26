/**
 * 统一日志系统
 *
 * 提供结构化、模块化的日志管理，支持：
 * - 日志级别控制
 * - 模块标识
 * - 上下文传播
 * - 多输出目标
 * - 与错误系统集成
 */

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 日志级别
 */
export enum LogLevel {
  Trace = 0,
  Debug = 1,
  Info = 2,
  Warn = 3,
  Error = 4,
  Fatal = 5,
}

/**
 * 日志级别名称映射
 */
const LogLevelNames: Record<LogLevel, string> = {
  [LogLevel.Trace]: 'trace',
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warn]: 'warn',
  [LogLevel.Error]: 'error',
  [LogLevel.Fatal]: 'fatal',
};

/**
 * 日志级别颜色（终端）
 */
const LogLevelColors: Record<LogLevel, string> = {
  [LogLevel.Trace]: '\x1b[90m',    // 灰色
  [LogLevel.Debug]: '\x1b[36m',    // 青色
  [LogLevel.Info]: '\x1b[32m',     // 绿色
  [LogLevel.Warn]: '\x1b[33m',     // 黄色
  [LogLevel.Error]: '\x1b[31m',    // 红色
  [LogLevel.Fatal]: '\x1b[35m',    // 紫色
};

const ResetColor = '\x1b[0m';

/**
 * 日志条目
 */
export interface LogEntry {
  /** 时间戳 ISO 8601 */
  timestamp: string;
  /** 日志级别 */
  level: LogLevel;
  /** 日志级别名称 */
  levelName: string;
  /** 模块名称 */
  module: string;
  /** 日志消息 */
  message: string;
  /** 上下文数据 */
  context?: Record<string, unknown>;
  /** 错误信息 */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  /** 会话 ID */
  sessionId?: string;
  /** 请求 ID */
  requestId?: string;
}

/**
 * 日志上下文
 */
export interface LogContext {
  sessionId?: string;
  requestId?: string;
  userId?: string;
  workspaceId?: string;
  conversationId?: string;
  [key: string]: unknown;
}

/**
 * 日志输出目标
 */
export interface LogTransport {
  name: string;
  log(entry: LogEntry): void;
  setLevel?(level: LogLevel): void;
}

/**
 * Logger 配置
 */
export interface LoggerConfig {
  /** 最小日志级别 */
  level?: LogLevel;
  /** 模块名称 */
  module: string;
  /** 输出目标 */
  transports?: LogTransport[];
  /** 全局上下文 */
  context?: LogContext;
}

// ============================================================================
// 输出目标实现
// ============================================================================

/**
 * 控制台输出目标
 * 
 * 开发友好的彩色输出
 */
export class ConsoleTransport implements LogTransport {
  name = 'console';
  private level: LogLevel = LogLevel.Info;

  constructor(level?: LogLevel) {
    this.level = level ?? LogLevel.Info;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  log(entry: LogEntry): void {
    if (entry.level < this.level) return;

    const color = LogLevelColors[entry.level];
    const levelName = LogLevelNames[entry.level].toUpperCase().padEnd(5);
    const timestamp = entry.timestamp.split('T')[1]?.slice(0, 12) || entry.timestamp;
    const moduleTag = `[${entry.module}]`;

    // 格式化前缀
    const prefix = `${color}${levelName}${ResetColor} ${timestamp} ${moduleTag}`;

    // 选择控制台方法
    const method = this.getConsoleMethod(entry.level);

    // 构建输出
    if (entry.error) {
      method(prefix, entry.message, entry.context ?? '', '\n  Error:', entry.error.name, entry.error.message);
      if (entry.error.stack) {
        method('  Stack:', entry.error.stack);
      }
    } else if (entry.context && Object.keys(entry.context).length > 0) {
      method(prefix, entry.message, entry.context);
    } else {
      method(prefix, entry.message);
    }
  }

  private getConsoleMethod(level: LogLevel): typeof console.log {
    switch (level) {
      case LogLevel.Fatal:
      case LogLevel.Error:
        return console.error.bind(console);
      case LogLevel.Warn:
        return console.warn.bind(console);
      case LogLevel.Info:
        return console.info.bind(console);
      default:
        return console.log.bind(console);
    }
  }
}

/**
 * JSON 输出目标
 * 
 * 生产环境的结构化 JSON 输出
 */
export class JsonTransport implements LogTransport {
  name = 'json';
  private level: LogLevel = LogLevel.Info;

  constructor(level?: LogLevel) {
    this.level = level ?? LogLevel.Info;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  log(entry: LogEntry): void {
    if (entry.level < this.level) return;
    console.log(JSON.stringify(entry));
  }
}

/**
 * 错误集成输出目标
 * 
 * 将 Error 和 Fatal 级别日志集成到 errorLogger
 */
export class ErrorIntegrationTransport implements LogTransport {
  name = 'error-integration';
  private level: LogLevel = LogLevel.Error;

  constructor(level?: LogLevel) {
    this.level = level ?? LogLevel.Error;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  log(entry: LogEntry): void {
    if (entry.level < this.level) return;

    // 动态导入以避免循环依赖
    import('../types/errors').then(({ AppError, ErrorSeverity, ErrorSource, errorLogger }) => {
      const severity = entry.level === LogLevel.Fatal
        ? ErrorSeverity.Critical
        : ErrorSeverity.Error;

      const error = new AppError({
        message: entry.message,
        source: this.inferSource(entry.module, ErrorSource),
        severity,
        context: entry.context,
      });
      errorLogger.log(error);
    }).catch(() => {
      // 忽略导入失败
    });
  }

  private inferSource(module: string, ErrorSource: typeof import('../types/errors').ErrorSource): import('../types/errors').ErrorSource {
    if (module.includes('git')) return ErrorSource.Git;
    if (module.includes('ai') || module.includes('engine')) return ErrorSource.AI;
    if (module.includes('file')) return ErrorSource.File;
    if (module.includes('network')) return ErrorSource.Network;
    return ErrorSource.System;
  }
}

// ============================================================================
// Logger 实现
// ============================================================================

/**
 * 模块日志器
 * 
 * 每个模块独立实例，自动携带模块标识
 */
export class ModuleLogger {
  private config: LoggerConfig;
  private transports: LogTransport[];

  constructor(config: LoggerConfig) {
    this.config = {
      level: LogLevel.Info,
      transports: [new ConsoleTransport()],
      ...config,
    };
    this.transports = this.config.transports ?? [];
  }

  /**
   * 获取当前日志级别
   */
  getLevel(): LogLevel {
    return this.config.level ?? LogLevel.Info;
  }

  /**
   * 设置日志级别
   */
  setLevel(level: LogLevel): void {
    this.config.level = level;
    this.transports.forEach(t => t.setLevel?.(level));
  }

  /**
   * 设置全局上下文
   */
  setContext(context: LogContext): void {
    this.config.context = { ...this.config.context, ...context };
  }

  /**
   * 清除上下文
   */
  clearContext(): void {
    this.config.context = undefined;
  }

  /**
   * 创建子日志器
   */
  child(subModule: string): ModuleLogger {
    return new ModuleLogger({
      ...this.config,
      module: `${this.config.module}:${subModule}`,
    });
  }

  // ===== 日志方法 =====

  trace(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.Trace, message, undefined, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.Debug, message, undefined, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.Info, message, undefined, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.Warn, message, undefined, context);
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.log(LogLevel.Error, message, error, context);
  }

  fatal(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.log(LogLevel.Fatal, message, error, context);
  }

  /**
   * 记录性能计时
   */
  time(label: string): () => void {
    const start = performance.now();
    return () => {
      const duration = performance.now() - start;
      this.debug(`${label} completed`, { duration: `${duration.toFixed(2)}ms` });
    };
  }

  /**
   * 记录进入函数
   */
  enter(fn: string, args?: Record<string, unknown>): void {
    this.trace(`→ ${fn}`, args);
  }

  /**
   * 记录退出函数
   */
  exit(fn: string, result?: unknown): void {
    this.trace(`← ${fn}`, result !== undefined ? { result } : undefined);
  }

  // ===== 私有方法 =====

  private log(
    level: LogLevel,
    message: string,
    error?: Error,
    context?: Record<string, unknown>
  ): void {
    // 级别过滤
    if (level < (this.config.level ?? LogLevel.Info)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      levelName: LogLevelNames[level],
      module: this.config.module,
      message,
      context: { ...this.config.context, ...context },
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : undefined,
      sessionId: this.config.context?.sessionId,
      requestId: this.config.context?.requestId,
    };

    // 分发到所有输出目标
    for (const transport of this.transports) {
      try {
        transport.log(entry);
      } catch (e) {
        // 避免日志本身出错导致应用崩溃
        console.error('[Logger] Transport error:', e);
      }
    }
  }
}

// ============================================================================
// 全局 Logger 管理
// ============================================================================

/**
 * 全局配置
 */
let globalLevel: LogLevel = import.meta.env.DEV ? LogLevel.Debug : LogLevel.Info;
let globalTransports: LogTransport[] = [];
let globalContext: LogContext = {};

// 模块日志器缓存
const loggerCache = new Map<string, ModuleLogger>();

/**
 * 创建或获取模块日志器
 * 
 * @param module 模块名称
 * @param options 可选配置
 * @returns 模块日志器实例
 * 
 * @example
 * ```ts
 * const log = createLogger('EventChatStore');
 * log.info('Session started', { sessionId: 'xxx' });
 * log.error('Failed to send message', err, { conversationId: 'xxx' });
 * ```
 */
export function createLogger(module: string, options?: Partial<LoggerConfig>): ModuleLogger {
  const cacheKey = module;

  if (loggerCache.has(cacheKey) && !options) {
    return loggerCache.get(cacheKey) ?? new ModuleLogger({ module });
  }

  const logger = new ModuleLogger({
    module,
    level: options?.level ?? globalLevel,
    transports: options?.transports ?? globalTransports,
    context: { ...globalContext, ...options?.context },
  });

  if (!options) {
    loggerCache.set(cacheKey, logger);
  }

  return logger;
}

/**
 * 设置全局日志级别
 */
export function setGlobalLevel(level: LogLevel): void {
  globalLevel = level;
  loggerCache.forEach(logger => logger.setLevel(level));
  globalTransports.forEach(t => t.setLevel?.(level));
}

/**
 * 设置全局上下文
 */
export function setGlobalContext(context: LogContext): void {
  globalContext = { ...globalContext, ...context };
  loggerCache.forEach(logger => logger.setContext(globalContext));
}

/**
 * 清除全局上下文
 */
export function clearGlobalContext(): void {
  globalContext = {};
  loggerCache.forEach(logger => logger.clearContext());
}

/**
 * 添加全局输出目标
 */
export function addGlobalTransport(transport: LogTransport): void {
  globalTransports.push(transport);
}

/**
 * 清除所有输出目标
 */
export function clearTransports(): void {
  globalTransports = [];
}

/**
 * 获取全局日志级别
 */
export function getGlobalLevel(): LogLevel {
  return globalLevel;
}

/**
 * 解析日志级别字符串
 */
export function parseLogLevel(level: string): LogLevel {
  const normalized = level.toLowerCase();
  switch (normalized) {
    case 'trace': return LogLevel.Trace;
    case 'debug': return LogLevel.Debug;
    case 'info': return LogLevel.Info;
    case 'warn':
    case 'warning': return LogLevel.Warn;
    case 'error': return LogLevel.Error;
    case 'fatal': return LogLevel.Fatal;
    default: return LogLevel.Info;
  }
}

// ============================================================================
// 默认导出
// ============================================================================

/**
 * @deprecated 使用 createLogger() 创建模块日志器，不要直接使用此对象
 *
 * 此对象保留仅为向后兼容，内部已委托给 ModuleLogger。
 * 新代码应使用：
 *   import { createLogger } from '@/utils/logger'
 *   const log = createLogger('ModuleName')
 *   log.info('message', { key: 'value' })
 */
export const logger = {
  debug: (message: string, ..._args: unknown[]) => {
    // 旧 API 兼容：委托给临时 ModuleLogger
    const tempLogger = createLogger('Legacy');
    tempLogger.debug(message);
  },
  info: (message: string, ..._args: unknown[]) => {
    const tempLogger = createLogger('Legacy');
    tempLogger.info(message);
  },
  warn: (message: string, ..._args: unknown[]) => {
    const tempLogger = createLogger('Legacy');
    tempLogger.warn(message);
  },
  error: (message: string, ..._args: unknown[]) => {
    const tempLogger = createLogger('Legacy');
    tempLogger.error(message);
  },
};

// 初始化默认输出目标
if (import.meta.env.DEV) {
  globalTransports = [new ConsoleTransport(LogLevel.Debug)];
} else {
  globalTransports = [new JsonTransport(LogLevel.Info)];
}