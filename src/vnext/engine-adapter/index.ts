/**
 * Scheduler vNext - AI Engine Adapter
 *
 * 适配 ai-runtime 的 AISession 到 vnext 的 ISession 接口
 * 这是连接 vnext 工作流引擎和真实 AI 引擎的桥梁
 */

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

import type {
  AISession,
  AITask,
  AIEvent,
} from '../../ai-runtime';

import { getEngine, getDefaultEngine } from '../../ai-runtime';

// ============================================================================
// ISession Interface (from session/index.ts)
// ============================================================================

/**
 * AI 会话接口 - vnext 版本
 */
export interface ISession {
  readonly id: string;
  readonly info: SessionInfo;
  readonly state: SessionState;
  readonly messages: Message[];
  readonly tokenUsage: TokenUsage;
  sendMessage(content: string, callbacks?: SessionEventCallbacks): Promise<SessionResult>;
  sendMessageStream(content: string, callbacks: SessionEventCallbacks): Promise<SessionResult>;
  pause(): void;
  resume(): void;
  cancel(): void;
  getEvents(): ExecutionEvent[];
  getToolCalls(): ToolCallRecord[];
  addMessage(message: Message): void;
  clearMessages(): void;
}

// ============================================================================
// AI Engine Adapter
// ============================================================================

/**
 * AI 引擎适配器
 *
 * 将 ai-runtime 的 AISession 适配为 vnext 的 ISession
 */
export class AIEngineAdapter implements ISession {
  readonly id: string;
  private _info: SessionInfo;
  private _messages: Message[] = [];
  private _events: ExecutionEvent[] = [];
  private _toolCalls: ToolCallRecord[] = [];
  private _tokenUsage: TokenUsage;
  private _state: SessionState;
  private _config: SessionConfig;
  private _aiSession: AISession | null = null;
  private _abortController: AbortController | null = null;
  private _outputBuffer: string = '';

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

  /**
   * 发送消息（非流式）
   */
  async sendMessage(content: string, callbacks?: SessionEventCallbacks): Promise<SessionResult> {
    return this.sendMessageStream(content, callbacks || {});
  }

  /**
   * 发送消息（流式）
   */
  async sendMessageStream(
    content: string,
    callbacks: SessionEventCallbacks
  ): Promise<SessionResult> {
    const startTime = Date.now();
    this._state = 'RUNNING';
    this._info.state = 'RUNNING';
    this._outputBuffer = '';

    // 添加用户消息
    const userMessage: Message = {
      role: 'user',
      content,
      timestamp: startTime,
    };
    this._messages.push(userMessage);

    try {
      // 获取 AI 引擎
      const engineId = this._config.engineId || 'claude-code';
      const engine = engineId === 'default'
        ? getDefaultEngine()
        : getEngine(engineId);

      if (!engine) {
        throw new Error(`Engine not found: ${engineId}`);
      }

      // 创建 AI 会话
      this._aiSession = engine.createSession({
        workspaceDir: this._config.workDir,
        timeout: this._config.timeout,
        verbose: false,
      });

      // 创建任务
      const task: AITask = {
        id: `task-${Date.now()}`,
        kind: 'chat',
        input: {
          prompt: this.buildPrompt(content),
        },
      };

      // 执行任务并处理事件
      await this.executeTask(task, callbacks);

      // 生成结果
      const result = this.createResult(startTime);

      this._state = 'COMPLETED';
      this._info.state = 'COMPLETED';
      callbacks.onComplete?.(result);

      return result;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this._state = 'FAILED';
      this._info.state = 'FAILED';
      this._info.error = errorMsg;
      callbacks.onError?.(errorMsg);

      return {
        sessionId: this.id,
        success: false,
        error: errorMsg,
        tokenUsage: this._tokenUsage,
        duration: Date.now() - startTime,
        events: this._events,
        toolCalls: this._toolCalls,
      };
    }
  }

  /**
   * 执行 AI 任务
   */
  private async executeTask(task: AITask, callbacks: SessionEventCallbacks): Promise<void> {
    if (!this._aiSession) return;

    this._abortController = new AbortController();

    try {
      const eventStream = this._aiSession.run(task);

      for await (const event of eventStream) {
        // 检查是否已取消
        if (this._abortController.signal.aborted) {
          break;
        }

        this.handleAIEvent(event, callbacks);
      }
    } catch (error) {
      if (this._state !== 'CANCELLED') {
        throw error;
      }
    }
  }

  /**
   * 处理 AI 事件
   */
  private handleAIEvent(event: AIEvent, callbacks: SessionEventCallbacks): void {
    switch (event.type) {
      case 'token':
        this._outputBuffer += event.value;
        callbacks.onOutput?.(event.value);
        this._tokenUsage.outputTokens += 1;
        break;

      case 'tool_call_start':
        callbacks.onToolCall?.(event.tool, event.args || {});
        break;

      case 'tool_call_end':
        const toolRecord: ToolCallRecord = {
          tool: event.tool,
          input: {},
          output: event.result ? String(event.result) : undefined,
          isError: !event.success,
          timestamp: Date.now(),
        };
        this._toolCalls.push(toolRecord);
        callbacks.onToolResult?.(event.tool, event.result ? String(event.result) : '', !event.success);
        break;

      case 'thinking':
        callbacks.onThinking?.(event.content);
        break;

      case 'error':
        callbacks.onError?.(event.error);
        this.addExecutionEvent('error', { message: event.error });
        break;

      case 'session_start':
        // Session 开始
        break;

      case 'session_end':
        // Session 结束
        break;

      case 'user_message':
        // 用户消息已经添加，忽略
        break;

      case 'assistant_message':
        this._outputBuffer = event.content;
        break;

      case 'progress':
        // 进度事件
        break;
    }

    // 记录所有事件
    this.addExecutionEventFromAI(event);
  }

  /**
   * 添加执行事件
   */
  private addExecutionEvent(type: ExecutionEvent['type'], data: Record<string, unknown>): void {
    this._events.push({
      type,
      timestamp: Date.now(),
      data,
    });
  }

  /**
   * 从 AI 事件转换
   */
  private addExecutionEventFromAI(event: AIEvent): void {
    const typeMap: Record<string, ExecutionEvent['type']> = {
      token: 'thinking',
      thinking: 'thinking',
      tool_call_start: 'tool_call',
      tool_call_end: 'tool_result',
      error: 'error',
      session_start: 'complete',
      session_end: 'complete',
    };

    const execType = typeMap[event.type] || 'thinking';
    this.addExecutionEvent(execType, event as unknown as Record<string, unknown>);
  }

  /**
   * 构建提示词
   */
  private buildPrompt(content: string): string {
    const profile = this._config.profile;
    const systemPrompt = this._config.systemPrompt || profile?.systemPolicy;

    if (systemPrompt) {
      return `${systemPrompt}\n\n---\n\n${content}`;
    }

    return content;
  }

  /**
   * 创建执行结果
   */
  private createResult(startTime: number): SessionResult {
    // 添加助手消息
    const assistantMessage: Message = {
      role: 'assistant',
      content: this._outputBuffer,
      timestamp: Date.now(),
      tokenCount: this._tokenUsage.outputTokens,
    };
    this._messages.push(assistantMessage);

    // 更新信息
    this._info.lastActiveAt = Date.now();
    this._info.rounds++;
    this._info.tokenUsage = { ...this._tokenUsage };

    return {
      sessionId: this.id,
      success: true,
      output: this._outputBuffer,
      tokenUsage: { ...this._tokenUsage },
      duration: Date.now() - startTime,
      events: this._events,
      toolCalls: this._toolCalls,
      score: this.calculateScore(),
    };
  }

  /**
   * 计算执行评分
   */
  private calculateScore(): number {
    // 基础分数
    let score = 75;

    // 根据工具调用调整
    if (this._toolCalls.length > 0) {
      score += Math.min(10, this._toolCalls.length * 2);
    }

    // 根据错误调整
    const errors = this._events.filter(e => e.type === 'error').length;
    score -= errors * 10;

    return Math.max(0, Math.min(100, score));
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
    this._abortController?.abort();
    this._aiSession?.abort();
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
    this._events = [];
    this._toolCalls = [];
    this._outputBuffer = '';
  }
}

// ============================================================================
// Session Factory
// ============================================================================

/**
 * 创建 AI 引擎适配器会话
 */
export function createAIEngineSession(id: string, config: SessionConfig): ISession {
  return new AIEngineAdapter(id, config);
}

// ============================================================================
// Exports
// ============================================================================

export * from './types';
