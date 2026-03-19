/**
 * Scheduler vNext - AI Session Manager
 *
 * 管理 AI 会话的创建、生命周期、销毁
 */

import type { AgentProfile } from '../types/profile';
import type {
  SessionConfig,
  SessionInfo,
  SessionState,
  SessionResult,
  Message,
  ExecutionEvent,
  SessionEventCallbacks,
  ToolCallRecord,
  TokenUsage,
} from './types';

// ============================================================================
// Session Interface
// ============================================================================

/**
 * AI 会话接口
 */
export interface ISession {
  /** 会话 ID */
  readonly id: string;

  /** 会话信息 */
  readonly info: SessionInfo;

  /** 当前状态 */
  readonly state: SessionState;

  /** 消息历史 */
  readonly messages: Message[];

  /** Token 使用量 */
  readonly tokenUsage: TokenUsage;

  /** 发送消息并获取响应 */
  sendMessage(content: string, callbacks?: SessionEventCallbacks): Promise<SessionResult>;

  /** 发送消息 (流式) */
  sendMessageStream(
    content: string,
    callbacks: SessionEventCallbacks
  ): Promise<SessionResult>;

  /** 暂停会话 */
  pause(): void;

  /** 恢复会话 */
  resume(): void;

  /** 取消会话 */
  cancel(): void;

  /** 获取执行事件 */
  getEvents(): ExecutionEvent[];

  /** 获取工具调用记录 */
  getToolCalls(): ToolCallRecord[];

  /** 添加消息到历史 */
  addMessage(message: Message): void;

  /** 清空消息历史 */
  clearMessages(): void;
}

// ============================================================================
// Session Manager Interface
// ============================================================================

/**
 * 会话管理器接口
 */
export interface ISessionManager {
  /** 创建会话 */
  createSession(config: SessionConfig): Promise<ISession>;

  /** 获取会话 */
  getSession(sessionId: string): ISession | undefined;

  /** 获取所有活跃会话 */
  getActiveSessions(): ISession[];

  /** 关闭会话 */
  closeSession(sessionId: string): Promise<void>;

  /** 关闭所有会话 */
  closeAllSessions(): Promise<void>;

  /** 获取会话统计 */
  getStats(): SessionManagerStats;

  /** 注册会话工厂 */
  registerSessionFactory(factory: SessionFactory): void;
}

// ============================================================================
// Session Factory
// ============================================================================

/**
 * 会话工厂函数类型
 */
export type SessionFactory = (
  id: string,
  config: SessionConfig
) => ISession;

// ============================================================================
// Session Manager Stats
// ============================================================================

export interface SessionManagerStats {
  /** 总会话数 */
  totalSessions: number;

  /** 活跃会话数 */
  activeSessions: number;

  /** 总 Token 使用量 */
  totalTokenUsage: TokenUsage;

  /** 总工具调用次数 */
  totalToolCalls: number;
}

// ============================================================================
// Mock Session Implementation (for testing)
// ============================================================================

/**
 * Mock 会话实现 - 用于测试和开发
 */
export class MockSession implements ISession {
  readonly id: string;
  private _info: SessionInfo;
  private _messages: Message[] = [];
  private _events: ExecutionEvent[] = [];
  private _toolCalls: ToolCallRecord[] = [];
  private _tokenUsage: TokenUsage;
  private _state: SessionState;
  private _config: SessionConfig;

  constructor(id: string, config: SessionConfig) {
    this.id = id;
    this._config = config;
    this._state = 'IDLE';
    this._tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    this._info = {
      id,
      engineId: config.engineId,
      state: 'IDLE',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      tokenUsage: this._tokenUsage,
      rounds: 0,
      profileId: config.profile?.id,
      workDir: config.workDir,
    };
  }

  get info(): SessionInfo {
    return { ...this._info };
  }

  get state(): SessionState {
    return this._state;
  }

  get messages(): Message[] {
    return [...this._messages];
  }

  get tokenUsage(): TokenUsage {
    return { ...this._tokenUsage };
  }

  async sendMessage(content: string, callbacks?: SessionEventCallbacks): Promise<SessionResult> {
    return this.sendMessageStream(content, callbacks || {});
  }

  async sendMessageStream(
    content: string,
    callbacks: SessionEventCallbacks
  ): Promise<SessionResult> {
    const startTime = Date.now();
    this._state = 'RUNNING';
    this._info.state = 'RUNNING';

    // 添加用户消息
    const userMessage: Message = {
      role: 'user',
      content,
      timestamp: startTime,
    };
    this._messages.push(userMessage);

    // 模拟思考
    callbacks.onThinking?.('Analyzing request...');

    // 模拟工具调用
    if (this._config.profile?.requiredTools?.includes('read')) {
      callbacks.onToolCall?.('read', { path: 'example.ts' });
      callbacks.onToolResult?.('read', 'file content here', false);
      this._toolCalls.push({
        tool: 'read',
        input: { path: 'example.ts' },
        output: 'file content here',
        timestamp: Date.now(),
      });
    }

    // 模拟输出
    const output = this.generateMockOutput(content);
    callbacks.onOutput?.(output);

    // 模拟 Token 使用
    const inputTokens = Math.ceil(content.length / 4);
    const outputTokens = Math.ceil(output.length / 4);
    this._tokenUsage.inputTokens += inputTokens;
    this._tokenUsage.outputTokens += outputTokens;
    this._tokenUsage.totalTokens = this._tokenUsage.inputTokens + this._tokenUsage.outputTokens;

    // 添加助手消息
    const assistantMessage: Message = {
      role: 'assistant',
      content: output,
      timestamp: Date.now(),
      tokenCount: outputTokens,
    };
    this._messages.push(assistantMessage);

    // 更新信息
    this._info.lastActiveAt = Date.now();
    this._info.rounds++;
    this._info.tokenUsage = { ...this._tokenUsage };

    const result: SessionResult = {
      sessionId: this.id,
      success: true,
      output,
      tokenUsage: { ...this._tokenUsage },
      duration: Date.now() - startTime,
      events: this._events,
      toolCalls: this._toolCalls,
      score: 75,
    };

    this._state = 'COMPLETED';
    this._info.state = 'COMPLETED';
    callbacks.onComplete?.(result);

    return result;
  }

  private generateMockOutput(content: string): string {
    const profile = this._config.profile;
    const role = profile?.role || 'assistant';

    return `[Mock ${role} Response]

Task: ${content.substring(0, 100)}...

Analysis:
- Understood the request
- Analyzed relevant context
- Identified key requirements

Actions Taken:
1. Read existing code
2. Implemented solution
3. Verified changes

Result: Task completed successfully.

Score: 75/100
Next Steps: Ready for next task.`;
  }

  pause(): void {
    this._state = 'PAUSED';
    this._info.state = 'PAUSED';
  }

  resume(): void {
    if (this._state === 'PAUSED') {
      this._state = 'RUNNING';
      this._info.state = 'RUNNING';
    }
  }

  cancel(): void {
    this._state = 'CANCELLED';
    this._info.state = 'CANCELLED';
  }

  getEvents(): ExecutionEvent[] {
    return [...this._events];
  }

  getToolCalls(): ToolCallRecord[] {
    return [...this._toolCalls];
  }

  addMessage(message: Message): void {
    this._messages.push(message);
    this._info.lastActiveAt = Date.now();
  }

  clearMessages(): void {
    this._messages = [];
    this._tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    this._info.tokenUsage = this._tokenUsage;
  }
}

// ============================================================================
// Session Manager Implementation
// ============================================================================

/**
 * 会话管理器实现
 */
export class SessionManager implements ISessionManager {
  private sessions: Map<string, ISession> = new Map();
  private sessionFactory: SessionFactory = (id, config) => new MockSession(id, config);
  private _stats: SessionManagerStats = {
    totalSessions: 0,
    activeSessions: 0,
    totalTokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    totalToolCalls: 0,
  };

  async createSession(config: SessionConfig): Promise<ISession> {
    const id = `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const session = this.sessionFactory(id, config);
    this.sessions.set(id, session);
    this._stats.totalSessions++;
    this._stats.activeSessions++;
    return session;
  }

  getSession(sessionId: string): ISession | undefined {
    return this.sessions.get(sessionId);
  }

  getActiveSessions(): ISession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.state === 'IDLE' || s.state === 'RUNNING' || s.state === 'PAUSED'
    );
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.cancel();
      this._stats.activeSessions--;
      this._stats.totalTokenUsage.inputTokens += session.tokenUsage.inputTokens;
      this._stats.totalTokenUsage.outputTokens += session.tokenUsage.outputTokens;
      this._stats.totalTokenUsage.totalTokens += session.tokenUsage.totalTokens;
      this._stats.totalToolCalls += session.getToolCalls().length;
      this.sessions.delete(sessionId);
    }
  }

  async closeAllSessions(): Promise<void> {
    for (const [id] of this.sessions) {
      await this.closeSession(id);
    }
  }

  getStats(): SessionManagerStats {
    return { ...this._stats };
  }

  registerSessionFactory(factory: SessionFactory): void {
    this.sessionFactory = factory;
  }
}

// ============================================================================
// Global Instance
// ============================================================================

let globalSessionManager: SessionManager | null = null;

/**
 * 获取全局会话管理器
 */
export function getSessionManager(): SessionManager {
  if (!globalSessionManager) {
    globalSessionManager = new SessionManager();
  }
  return globalSessionManager;
}

/**
 * 重置全局会话管理器
 */
export function resetSessionManager(): void {
  globalSessionManager = null;
}

// ============================================================================
// Exports
// ============================================================================

export * from './types';
