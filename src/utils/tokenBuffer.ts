/**
 * Token Buffer - 流式响应批量处理优化
 *
 * 问题：在流式响应中，每个 token 都会触发一次状态更新，导致：
 * 1. 大量的 React 重渲染
 * 2. Zustand store 频繁更新
 * 3. Markdown 反复解析
 *
 * 解决方案：
 * - 使用 requestAnimationFrame 批量累积 tokens
 * - 在浏览器渲染周期内统一更新
 * - 支持最大延迟限制（防止卡顿时显示过慢）
 *
 * 预期收益：减少 90% 的状态更新次数
 */

interface TokenBufferOptions {
  /** 最大缓冲延迟（毫秒），超过此时间强制刷新 */
  maxDelay?: number;
  /** 最大缓冲大小（字符数），超过立即刷新 */
  maxSize?: number;
  /** 动态调整策略：根据已累积内容长度动态调整参数 */
  dynamicConfig?: {
    /** 内容长度阈值，超过后使用更大的批处理参数 */
    contentLengthThreshold: number;
    /** 长内容时的最大延迟 */
    longContentMaxDelay: number;
    /** 长内容时的最大缓冲大小 */
    longContentMaxSize: number;
  };
}

interface BufferFlushCallback {
  (content: string, isFinal: boolean): void;
}

// 默认配置
const DEFAULT_MAX_DELAY = 80; // 优化：从 50ms 提升到 80ms
const DEFAULT_MAX_SIZE = 800; // 优化：从 500 提升到 800

// 长内容配置（内容超过阈值时使用）
const LONG_CONTENT_THRESHOLD = 3000;
const LONG_CONTENT_MAX_DELAY = 120;
const LONG_CONTENT_MAX_SIZE = 1500;

export class TokenBuffer {
  private buffer: string[] = [];
  private rafId: number | null = null;
  private timeoutId: number | null = null;
  private readonly baseMaxDelay: number;
  private readonly baseMaxSize: number;
  private readonly onFlush: BufferFlushCallback;
  private isDestroyed = false;
  private totalContentLength = 0;
  private readonly dynamicConfig?: TokenBufferOptions['dynamicConfig'];

  constructor(onFlush: BufferFlushCallback, options: TokenBufferOptions = {}) {
    this.onFlush = onFlush;
    this.baseMaxDelay = options.maxDelay ?? DEFAULT_MAX_DELAY;
    this.baseMaxSize = options.maxSize ?? DEFAULT_MAX_SIZE;

    // 动态配置（可选）
    this.dynamicConfig = options.dynamicConfig ?? {
      contentLengthThreshold: LONG_CONTENT_THRESHOLD,
      longContentMaxDelay: LONG_CONTENT_MAX_DELAY,
      longContentMaxSize: LONG_CONTENT_MAX_SIZE,
    };
  }

  /**
   * 获取当前应使用的最大延迟（动态调整）
   */
  private getCurrentMaxDelay(): number {
    if (!this.dynamicConfig) return this.baseMaxDelay;
    if (this.totalContentLength > this.dynamicConfig.contentLengthThreshold) {
      return this.dynamicConfig.longContentMaxDelay;
    }
    return this.baseMaxDelay;
  }

  /**
   * 获取当前应使用的最大缓冲大小（动态调整）
   */
  private getCurrentMaxSize(): number {
    if (!this.dynamicConfig) return this.baseMaxSize;
    if (this.totalContentLength > this.dynamicConfig.contentLengthThreshold) {
      return this.dynamicConfig.longContentMaxSize;
    }
    return this.baseMaxSize;
  }

  /**
   * 添加 token 到缓冲区
   */
  append(token: string): void {
    if (this.isDestroyed) return;
    if (!token) return;

    this.buffer.push(token);
    this.totalContentLength += token.length;

    // 检查是否达到最大缓冲大小（动态）
    const bufferSize = this.buffer.reduce((sum, s) => sum + s.length, 0);
    if (bufferSize >= this.getCurrentMaxSize()) {
      this.flush(false);
      return;
    }

    // 如果没有已调度的刷新，调度一个
    if (this.rafId === null && this.timeoutId === null) {
      this.scheduleFlush();
    }
  }

  /**
   * 调度下一次刷新
   */
  private scheduleFlush(): void {
    if (this.isDestroyed) return;

    // 使用 requestAnimationFrame 在浏览器渲染前刷新
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.flush(false);
    });

    // 同时设置超时作为兜底，防止 rAF 被延迟时显示卡顿
    this.timeoutId = window.setTimeout(() => {
      this.timeoutId = null;
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.flush(false);
    }, this.getCurrentMaxDelay());
  }

  /**
   * 刷新缓冲区，将累积的内容发送出去
   * @param isFinal 是否为最终刷新（会清理所有状态）
   */
  flush(isFinal: boolean = false): void {
    if (this.isDestroyed) return;

    // 清除调度
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    // 如果缓冲区为空，不执行回调
    if (this.buffer.length === 0) return;

    // 合并所有 tokens
    const content = this.buffer.join('');
    this.buffer = [];

    // 调用回调
    try {
      this.onFlush(content, isFinal);
    } catch (error) {
      console.error('[TokenBuffer] Flush callback error:', error);
    }

    // 如果是最终刷新，清理状态
    if (isFinal) {
      this.destroy();
    }
  }

  /**
   * 获取当前缓冲区大小（字符数）
   */
  get size(): number {
    return this.buffer.reduce((sum, s) => sum + s.length, 0);
  }

  /**
   * 检查缓冲区是否为空
   */
  get empty(): boolean {
    return this.buffer.length === 0;
  }

  /**
   * 强制完成（通常在流式响应结束时调用）
   */
  end(): void {
    this.flush(true);
  }

  /**
   * 销毁缓冲区，清理资源
   */
  destroy(): void {
    if (this.isDestroyed) return;

    this.flush(true);
    this.isDestroyed = true;
    this.buffer = [];
  }

  /**
   * 重置缓冲区（用于中断等场景）
   */
  reset(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.buffer = [];
  }

  /**
   * 重置内容长度计数器（在消息完成时调用）
   */
  resetContentLength(): void {
    this.totalContentLength = 0;
  }

  /**
   * 获取已累积的总内容长度
   */
  get contentLength(): number {
    return this.totalContentLength;
  }
}

/**
 * Token Buffer 管理器 - 管理多个会话的 TokenBuffer
 */
export class TokenBufferManager {
  private buffers = new Map<string, TokenBuffer>();

  /**
   * 获取或创建指定会话的 TokenBuffer
   */
  getOrCreate(sessionId: string, onFlush: BufferFlushCallback, options?: TokenBufferOptions): TokenBuffer {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = new TokenBuffer(onFlush, options);
      this.buffers.set(sessionId, buffer);
    }
    return buffer;
  }

  /**
   * 结束指定会话的缓冲
   */
  end(sessionId: string): void {
    const buffer = this.buffers.get(sessionId);
    if (buffer) {
      buffer.end();
      this.buffers.delete(sessionId);
    }
  }

  /**
   * 重置指定会话的缓冲
   */
  reset(sessionId: string): void {
    const buffer = this.buffers.get(sessionId);
    if (buffer) {
      buffer.reset();
    }
  }

  /**
   * 强制刷新指定会话的缓冲
   */
  flush(sessionId: string): void {
    const buffer = this.buffers.get(sessionId);
    if (buffer) {
      buffer.flush(false);
    }
  }

  /**
   * 清理所有缓冲区
   */
  destroy(): void {
    for (const buffer of this.buffers.values()) {
      buffer.destroy();
    }
    this.buffers.clear();
  }

  /**
   * 获取活跃缓冲区数量
   */
  get size(): number {
    return this.buffers.size;
  }
}
