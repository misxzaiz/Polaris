/**
 * 统一日志系统测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LogLevel,
  LogEntry,
  createLogger,
  setGlobalLevel,
  getGlobalLevel,
  setGlobalContext,
  clearGlobalContext,
  parseLogLevel,
  ModuleLogger,
  ConsoleTransport,
  JsonTransport,
} from './logger';

describe('LogLevel', () => {
  it('should have correct level ordering', () => {
    expect(LogLevel.Trace).toBeLessThan(LogLevel.Debug);
    expect(LogLevel.Debug).toBeLessThan(LogLevel.Info);
    expect(LogLevel.Info).toBeLessThan(LogLevel.Warn);
    expect(LogLevel.Warn).toBeLessThan(LogLevel.Error);
    expect(LogLevel.Error).toBeLessThan(LogLevel.Fatal);
  });
});

describe('parseLogLevel', () => {
  it('should parse level strings correctly', () => {
    expect(parseLogLevel('trace')).toBe(LogLevel.Trace);
    expect(parseLogLevel('debug')).toBe(LogLevel.Debug);
    expect(parseLogLevel('info')).toBe(LogLevel.Info);
    expect(parseLogLevel('warn')).toBe(LogLevel.Warn);
    expect(parseLogLevel('warning')).toBe(LogLevel.Warn);
    expect(parseLogLevel('error')).toBe(LogLevel.Error);
    expect(parseLogLevel('fatal')).toBe(LogLevel.Fatal);
  });

  it('should handle case insensitivity', () => {
    expect(parseLogLevel('DEBUG')).toBe(LogLevel.Debug);
    expect(parseLogLevel('Info')).toBe(LogLevel.Info);
  });

  it('should return Info for unknown levels', () => {
    expect(parseLogLevel('unknown')).toBe(LogLevel.Info);
    expect(parseLogLevel('')).toBe(LogLevel.Info);
  });
});

describe('ConsoleTransport', () => {
  let transport: ConsoleTransport;
  let consoleSpy: {
    log: ReturnType<typeof vi.spyOn>;
    info: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    transport = new ConsoleTransport(LogLevel.Debug);
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should log entries at or above configured level', () => {
    const entry: LogEntry = {
      timestamp: '2024-01-01T00:00:00.000Z',
      level: LogLevel.Info,
      levelName: 'info',
      module: 'test',
      message: 'test message',
    };

    transport.log(entry);
    expect(consoleSpy.info).toHaveBeenCalled();
  });

  it('should skip entries below configured level', () => {
    const entry: LogEntry = {
      timestamp: '2024-01-01T00:00:00.000Z',
      level: LogLevel.Trace,
      levelName: 'trace',
      module: 'test',
      message: 'trace message',
    };

    transport.log(entry);
    expect(consoleSpy.log).not.toHaveBeenCalled();
  });

  it('should use error console for error level', () => {
    const entry: LogEntry = {
      timestamp: '2024-01-01T00:00:00.000Z',
      level: LogLevel.Error,
      levelName: 'error',
      module: 'test',
      message: 'error message',
    };

    transport.log(entry);
    expect(consoleSpy.error).toHaveBeenCalled();
  });

  it('should use warn console for warn level', () => {
    const entry: LogEntry = {
      timestamp: '2024-01-01T00:00:00.000Z',
      level: LogLevel.Warn,
      levelName: 'warn',
      module: 'test',
      message: 'warn message',
    };

    transport.log(entry);
    expect(consoleSpy.warn).toHaveBeenCalled();
  });

  it('should log error details', () => {
    const entry: LogEntry = {
      timestamp: '2024-01-01T00:00:00.000Z',
      level: LogLevel.Error,
      levelName: 'error',
      module: 'test',
      message: 'error with details',
      error: {
        name: 'TestError',
        message: 'test error',
        stack: 'at test.js:1',
      },
    };

    transport.log(entry);
    expect(consoleSpy.error).toHaveBeenCalled();
  });
});

describe('JsonTransport', () => {
  let transport: JsonTransport;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    transport = new JsonTransport(LogLevel.Info);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should output JSON formatted log', () => {
    const entry: LogEntry = {
      timestamp: '2024-01-01T00:00:00.000Z',
      level: LogLevel.Info,
      levelName: 'info',
      module: 'test',
      message: 'test message',
    };

    transport.log(entry);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(entry));
  });

  it('should skip entries below configured level', () => {
    const entry: LogEntry = {
      timestamp: '2024-01-01T00:00:00.000Z',
      level: LogLevel.Debug,
      levelName: 'debug',
      module: 'test',
      message: 'debug message',
    };

    transport.log(entry);
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});

describe('ModuleLogger', () => {
  let mockTransport: { log: ReturnType<typeof vi.fn>; name: string };
  let logger: ModuleLogger;

  beforeEach(() => {
    mockTransport = {
      log: vi.fn(),
      name: 'mock',
    };
    logger = new ModuleLogger({
      module: 'TestModule',
      level: LogLevel.Trace, // 使用 Trace 级别以测试所有方法
      transports: [mockTransport as any],
    });
  });

  describe('log methods', () => {
    it('should log trace messages', () => {
      logger.trace('trace message');
      expect(mockTransport.log).toHaveBeenCalledWith(
        expect.objectContaining({
          level: LogLevel.Trace,
          message: 'trace message',
        })
      );
    });

    it('should log debug messages', () => {
      logger.debug('debug message');
      expect(mockTransport.log).toHaveBeenCalledWith(
        expect.objectContaining({
          level: LogLevel.Debug,
          message: 'debug message',
        })
      );
    });

    it('should log info messages', () => {
      logger.info('info message');
      expect(mockTransport.log).toHaveBeenCalledWith(
        expect.objectContaining({
          level: LogLevel.Info,
          message: 'info message',
        })
      );
    });

    it('should log warn messages', () => {
      logger.warn('warn message');
      expect(mockTransport.log).toHaveBeenCalledWith(
        expect.objectContaining({
          level: LogLevel.Warn,
          message: 'warn message',
        })
      );
    });

    it('should log error messages with error object', () => {
      const error = new Error('test error');
      logger.error('error message', error);
      expect(mockTransport.log).toHaveBeenCalledWith(
        expect.objectContaining({
          level: LogLevel.Error,
          message: 'error message',
          error: {
            name: 'Error',
            message: 'test error',
            stack: expect.any(String),
          },
        })
      );
    });

    it('should log fatal messages', () => {
      logger.fatal('fatal message');
      expect(mockTransport.log).toHaveBeenCalledWith(
        expect.objectContaining({
          level: LogLevel.Fatal,
          message: 'fatal message',
        })
      );
    });
  });

  describe('context handling', () => {
    it('should include context in log entries', () => {
      logger.info('message with context', { key: 'value' });
      expect(mockTransport.log).toHaveBeenCalledWith(
        expect.objectContaining({
          context: { key: 'value' },
        })
      );
    });

    it('should merge global and local context', () => {
      const loggerWithContext = new ModuleLogger({
        module: 'Test',
        level: LogLevel.Debug,
        transports: [mockTransport as any],
        context: { globalKey: 'globalValue' },
      });

      loggerWithContext.info('message', { localKey: 'localValue' });
      expect(mockTransport.log).toHaveBeenCalledWith(
        expect.objectContaining({
          context: {
            globalKey: 'globalValue',
            localKey: 'localValue',
          },
        })
      );
    });

    it('should allow setting context after creation', () => {
      logger.setContext({ sessionId: 'session-123' });
      logger.info('message');
      expect(mockTransport.log).toHaveBeenCalledWith(
        expect.objectContaining({
          context: { sessionId: 'session-123' },
        })
      );
    });

    it('should allow clearing context', () => {
      logger.setContext({ sessionId: 'session-123' });
      logger.clearContext();
      logger.info('message');
      expect(mockTransport.log).toHaveBeenCalledWith(
        expect.objectContaining({
          context: {}, // clearContext 后是空对象
        })
      );
    });
  });

  describe('level filtering', () => {
    it('should filter messages below configured level', () => {
      logger.setLevel(LogLevel.Warn);
      logger.debug('debug message');
      expect(mockTransport.log).not.toHaveBeenCalled();
    });

    it('should allow messages at configured level', () => {
      logger.setLevel(LogLevel.Warn);
      logger.warn('warn message');
      expect(mockTransport.log).toHaveBeenCalled();
    });
  });

  describe('child logger', () => {
    it('should create child logger with extended module name', () => {
      const child = logger.child('SubModule');
      child.info('child message');
      expect(mockTransport.log).toHaveBeenCalledWith(
        expect.objectContaining({
          module: 'TestModule:SubModule',
        })
      );
    });
  });

  describe('utility methods', () => {
    it('should time operations', () => {
      const done = logger.time('operation');
      done();
      expect(mockTransport.log).toHaveBeenCalledWith(
        expect.objectContaining({
          level: LogLevel.Debug,
          message: expect.stringContaining('operation completed'),
        })
      );
    });

    it('should log function entry', () => {
      logger.enter('testFunction', { arg: 'value' });
      expect(mockTransport.log).toHaveBeenCalledWith(
        expect.objectContaining({
          level: LogLevel.Trace,
          message: '→ testFunction',
          context: { arg: 'value' },
        })
      );
    });

    it('should log function exit', () => {
      logger.exit('testFunction', 'value');
      expect(mockTransport.log).toHaveBeenCalledWith(
        expect.objectContaining({
          level: LogLevel.Trace,
          message: '← testFunction',
          context: { result: 'value' },
        })
      );
    });
  });
});

describe('createLogger', () => {
  it('should create logger with module name', () => {
    const logger = createLogger('TestModule');
    expect(logger).toBeInstanceOf(ModuleLogger);
  });

  it('should cache loggers by default', () => {
    const logger1 = createLogger('CachedModule');
    const logger2 = createLogger('CachedModule');
    expect(logger1).toBe(logger2);
  });

  it('should not cache loggers with custom options', () => {
    const logger1 = createLogger('CustomModule', { level: LogLevel.Debug });
    const logger2 = createLogger('CustomModule', { level: LogLevel.Info });
    expect(logger1).not.toBe(logger2);
  });
});

describe('global configuration', () => {
  it('should set global level', () => {
    setGlobalLevel(LogLevel.Error);
    expect(getGlobalLevel()).toBe(LogLevel.Error);
    // Reset
    setGlobalLevel(LogLevel.Info);
  });

  it('should set global context', () => {
    setGlobalContext({ sessionId: 'global-session' });
    const logger = createLogger('GlobalContextTest');
    // Logger should have global context
    expect(logger).toBeInstanceOf(ModuleLogger);
    clearGlobalContext();
  });
});
