/**
 * Scheduler vNext - Engine Adapter Types
 *
 * AI 引擎适配器类型定义
 */

// Re-export from session types
export type {
  SessionConfig,
  SessionInfo,
  SessionState,
  SessionResult,
  Message,
  ExecutionEvent,
  SessionEventCallbacks,
  ToolCallRecord,
  TokenUsage,
} from '../session/types';

/**
 * 引擎适配器配置
 */
export interface EngineAdapterConfig {
  /** 默认引擎 ID */
  defaultEngineId?: string;

  /** 工作目录 */
  workDir?: string;

  /** 超时时间 */
  timeout?: number;

  /** 是否启用详细日志 */
  verbose?: boolean;
}

/**
 * 引擎适配器状态
 */
export type EngineAdapterState =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'running'
  | 'error';

/**
 * 引擎适配器信息
 */
export interface EngineAdapterInfo {
  /** 适配器 ID */
  id: string;

  /** 当前状态 */
  state: EngineAdapterState;

  /** 可用的引擎列表 */
  availableEngines: string[];

  /** 当前使用的引擎 */
  currentEngine?: string;

  /** 总会话数 */
  totalSessions: number;

  /** 活跃会话数 */
  activeSessions: number;
}

/**
 * 引擎适配器事件
 */
export interface EngineAdapterEvent {
  /** 事件类型 */
  type: 'session_created' | 'session_started' | 'session_completed' | 'session_failed' | 'error';

  /** 时间戳 */
  timestamp: number;

  /** 会话 ID */
  sessionId?: string;

  /** 引擎 ID */
  engineId?: string;

  /** 错误信息 */
  error?: string;
}
