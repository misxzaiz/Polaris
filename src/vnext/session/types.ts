/**
 * Scheduler vNext - Session Types
 *
 * AI 会话相关类型定义
 */

import type { AgentProfile } from '../types/profile';
import type { TokenUsage } from '../types/execution';

// ============================================================================
// Session State
// ============================================================================

/**
 * 会话状态
 */
export type SessionState =
  | 'IDLE'       // 空闲，未启动
  | 'RUNNING'    // 正在执行
  | 'PAUSED'     // 已暂停
  | 'COMPLETED'  // 已完成
  | 'FAILED'     // 已失败
  | 'CANCELLED'; // 已取消

// ============================================================================
// Session Config
// ============================================================================

/**
 * 会话配置
 */
export interface SessionConfig {
  /** 引擎 ID */
  engineId: string;

  /** 工作目录 */
  workDir?: string;

  /** 最大 Token 数 */
  maxTokens?: number;

  /** 温度参数 */
  temperature?: number;

  /** 超时时间 (ms) */
  timeout?: number;

  /** 系统提示词 */
  systemPrompt?: string;

  /** 使用的 Profile */
  profile?: AgentProfile;

  /** 额外配置 */
  extraConfig?: Record<string, unknown>;
}

/**
 * 默认会话配置
 */
export const DEFAULT_SESSION_CONFIG: Required<Omit<SessionConfig, 'profile' | 'extraConfig'>> = {
  engineId: 'default',
  workDir: '',
  maxTokens: 128000,
  temperature: 0.7,
  timeout: 5 * 60 * 1000, // 5 分钟
  systemPrompt: '',
};

// ============================================================================
// Session Info
// ============================================================================

/**
 * 会话信息
 */
export interface SessionInfo {
  /** 会话 ID */
  id: string;

  /** 关联的节点 ID */
  nodeId?: string;

  /** 关联的工作流 ID */
  workflowId?: string;

  /** 引擎 ID */
  engineId: string;

  /** 当前状态 */
  state: SessionState;

  /** 创建时间 */
  createdAt: number;

  /** 最后活动时间 */
  lastActiveAt: number;

  /** Token 使用量 */
  tokenUsage: TokenUsage;

  /** 执行轮次 */
  rounds: number;

  /** 使用的 Profile ID */
  profileId?: string;

  /** 工作目录 */
  workDir?: string;

  /** 错误信息 */
  error?: string;
}

// ============================================================================
// Message Types
// ============================================================================

/**
 * 消息角色
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 消息内容类型
 */
export type MessageContentType = 'text' | 'image' | 'tool_use' | 'tool_result';

/**
 * 消息内容
 */
export interface MessageContent {
  /** 内容类型 */
  type: MessageContentType;

  /** 文本内容 */
  text?: string;

  /** 图片 URL (type=image) */
  imageUrl?: string;

  /** 工具调用 (type=tool_use) */
  toolUse?: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  };

  /** 工具结果 (type=tool_result) */
  toolResult?: {
    toolUseId: string;
    content: string;
    isError?: boolean;
  };
}

/**
 * 消息
 */
export interface Message {
  /** 角色 */
  role: MessageRole;

  /** 内容 */
  content: string | MessageContent[];

  /** 时间戳 */
  timestamp: number;

  /** Token 数量 */
  tokenCount?: number;
}

// ============================================================================
// Execution Events
// ============================================================================

/**
 * 执行事件类型
 */
export type ExecutionEventType =
  | 'thinking'
  | 'reading'
  | 'writing'
  | 'tool_call'
  | 'tool_result'
  | 'decision'
  | 'error'
  | 'complete';

/**
 * 执行事件
 */
export interface ExecutionEvent {
  /** 事件类型 */
  type: ExecutionEventType;

  /** 时间戳 */
  timestamp: number;

  /** 事件数据 */
  data: Record<string, unknown>;

  /** 关联的消息 ID */
  messageId?: string;
}

// ============================================================================
// Session Result
// ============================================================================

/**
 * 会话执行结果
 */
export interface SessionResult {
  /** 会话 ID */
  sessionId: string;

  /** 是否成功 */
  success: boolean;

  /** 输出文本 */
  output?: string;

  /** 错误信息 */
  error?: string;

  /** Token 使用量 */
  tokenUsage: TokenUsage;

  /** 执行时长 (ms) */
  duration: number;

  /** 执行事件列表 */
  events: ExecutionEvent[];

  /** 工具调用记录 */
  toolCalls: ToolCallRecord[];

  /** 评分 */
  score?: number;
}

/**
 * 工具调用记录
 */
export interface ToolCallRecord {
  /** 工具名称 */
  tool: string;

  /** 输入参数 */
  input: Record<string, unknown>;

  /** 输出结果 */
  output?: string;

  /** 是否错误 */
  isError?: boolean;

  /** 时间戳 */
  timestamp: number;

  /** 执行时长 (ms) */
  duration?: number;
}

// ============================================================================
// Session Events (for streaming)
// ============================================================================

/**
 * 会话事件回调
 */
export interface SessionEventCallbacks {
  /** 思考事件 */
  onThinking?: (thinking: string) => void;

  /** 工具调用事件 */
  onToolCall?: (tool: string, input: Record<string, unknown>) => void;

  /** 工具结果事件 */
  onToolResult?: (tool: string, result: string, isError: boolean) => void;

  /** 输出事件 */
  onOutput?: (text: string) => void;

  /** 错误事件 */
  onError?: (error: string) => void;

  /** 完成事件 */
  onComplete?: (result: SessionResult) => void;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 生成会话 ID
 */
export function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * 创建默认会话信息
 */
export function createDefaultSessionInfo(id: string, config: SessionConfig): SessionInfo {
  return {
    id,
    engineId: config.engineId,
    state: 'IDLE',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    rounds: 0,
    profileId: config.profile?.id,
    workDir: config.workDir,
  };
}

/**
 * 检查会话是否活跃
 */
export function isSessionActive(state: SessionState): boolean {
  return state === 'IDLE' || state === 'RUNNING' || state === 'PAUSED';
}

/**
 * 检查会话是否已结束
 */
export function isSessionTerminal(state: SessionState): boolean {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED';
}
