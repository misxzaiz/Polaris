/**
 * Runtime Monitor Types
 * 实时执行监控数据输出
 */

/**
 * 监控事件类型
 */
export enum MonitorEventType {
  // 工作流事件
  WORKFLOW_STARTED = 'workflow_started',
  WORKFLOW_PAUSED = 'workflow_paused',
  WORKFLOW_RESUMED = 'workflow_resumed',
  WORKFLOW_STOPPED = 'workflow_stopped',
  WORKFLOW_COMPLETED = 'workflow_completed',
  WORKFLOW_FAILED = 'workflow_failed',

  // 节点事件
  NODE_STARTED = 'node_started',
  NODE_COMPLETED = 'node_completed',
  NODE_FAILED = 'node_failed',
  NODE_SKIPPED = 'node_skipped',

  // 执行事件
  EXECUTION_THINKING = 'execution_thinking',
  EXECUTION_READING = 'execution_reading',
  EXECUTION_WRITING = 'execution_writing',
  EXECUTION_TOOL_CALL = 'execution_tool_call',
  EXECUTION_DECISION = 'execution_decision',
  EXECUTION_OUTPUT = 'execution_output',
  EXECUTION_ERROR = 'execution_error',

  // 资源事件
  TOKEN_USAGE_UPDATE = 'token_usage_update',
  MEMORY_UPDATE = 'memory_update',
  COST_UPDATE = 'cost_update',

  // 系统事件
  HEARTBEAT = 'heartbeat',
  WARNING = 'warning',
  ERROR = 'error',
}

/**
 * 工作流运行时状态
 */
export interface WorkflowRuntimeStatus {
  /** 工作流 ID */
  workflowId: string;
  /** 工作流名称 */
  workflowName: string;
  /** 当前状态 */
  status: 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed';
  /** 当前执行节点 ID */
  currentNodeId?: string;
  /** 当前执行节点名称 */
  currentNodeName?: string;
  /** 已完成节点数 */
  completedNodes: number;
  /** 总节点数 */
  totalNodes: number;
  /** 当前轮次 */
  currentRound: number;
  /** 开始时间 */
  startedAt?: number;
  /** 运行时长 (毫秒) */
  duration?: number;
  /** Token 使用量 */
  tokenUsage: TokenUsage;
  /** 预估成本 */
  estimatedCost: number;
  /** 错误信息 */
  lastError?: string;
  /** 最后更新时间 */
  lastUpdatedAt: number;
}

/**
 * 节点运行时状态
 */
export interface NodeRuntimeStatus {
  /** 节点 ID */
  nodeId: string;
  /** 节点名称 */
  nodeName: string;
  /** 工作流 ID */
  workflowId: string;
  /** 当前状态 */
  status: 'idle' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';
  /** 执行次数 */
  executionCount: number;
  /** 当前轮次 */
  currentRound?: number;
  /** 开始时间 */
  startedAt?: number;
  /** 结束时间 */
  finishedAt?: number;
  /** 执行时长 (毫秒) */
  duration?: number;
  /** Token 使用量 */
  tokenUsage: TokenUsage;
  /** 输出摘要 */
  outputSummary?: string;
  /** 错误信息 */
  lastError?: string;
  /** 最后更新时间 */
  lastUpdatedAt: number;
}

/**
 * Token 使用量
 */
export interface TokenUsage {
  /** 输入 Token */
  input: number;
  /** 输出 Token */
  output: number;
  /** 总计 */
  total: number;
}

/**
 * 执行日志条目
 */
export interface ExecutionLogEntry {
  /** 唯一标识 */
  id: string;
  /** 工作流 ID */
  workflowId: string;
  /** 节点 ID */
  nodeId?: string;
  /** 事件类型 */
  type: MonitorEventType;
  /** 标题 */
  title: string;
  /** 内容 */
  content: string;
  /** 时间戳 */
  timestamp: number;
  /** 级别 */
  level: 'info' | 'warning' | 'error' | 'debug';
  /** 持续时间 (毫秒) */
  duration?: number;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 资源使用统计
 */
export interface ResourceUsageStats {
  /** 工作流 ID */
  workflowId: string;
  /** 时间范围 */
  timeRange: {
    start: number;
    end: number;
  };
  /** 总 Token 使用量 */
  totalTokens: TokenUsage;
  /** 总执行时间 (毫秒) */
  totalDuration: number;
  /** 节点执行次数 */
  nodeExecutionCount: number;
  /** 平均每次执行时间 */
  avgExecutionTime: number;
  /** 平均每次 Token 使用 */
  avgTokensPerExecution: TokenUsage;
  /** 错误次数 */
  errorCount: number;
  /** 错误率 */
  errorRate: number;
  /** 预估成本 */
  estimatedCost: number;
  /** 成本明细 */
  costBreakdown: {
    inputCost: number;
    outputCost: number;
    totalCost: number;
  };
}

/**
 * 实时指标
 */
export interface RealtimeMetrics {
  /** 活跃工作流数 */
  activeWorkflows: number;
  /** 运行中节点数 */
  runningNodes: number;
  /** 当前 Token 使用速率 (tokens/min) */
  tokenRate: number;
  /** 当前请求速率 (requests/min) */
  requestRate: number;
  /** 平均响应时间 (毫秒) */
  avgResponseTime: number;
  /** 系统负载 */
  systemLoad: number;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 监控配置
 */
export interface MonitorConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 日志保留时间 (毫秒) */
  logRetentionMs: number;
  /** 最大日志条数 */
  maxLogEntries: number;
  /** 心跳间隔 (毫秒) */
  heartbeatIntervalMs: number;
  /** 是否收集详细日志 */
  collectDetailedLogs: boolean;
  /** Token 价格配置 (每 1M tokens) */
  tokenPricing: {
    input: number;
    output: number;
  };
  /** 实时指标窗口大小 (毫秒) */
  metricsWindowSizeMs: number;
}

/**
 * 监控事件
 */
export interface MonitorEvent {
  /** 事件类型 */
  type: MonitorEventType;
  /** 工作流 ID */
  workflowId: string;
  /** 节点 ID */
  nodeId?: string;
  /** 时间戳 */
  timestamp: number;
  /** 事件数据 */
  data?: unknown;
}

/**
 * 监控监听器
 */
export type MonitorListener = (event: MonitorEvent) => void;

/**
 * 默认监控配置
 */
export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  enabled: true,
  logRetentionMs: 24 * 60 * 60 * 1000, // 24 hours
  maxLogEntries: 10000,
  heartbeatIntervalMs: 30000, // 30 seconds
  collectDetailedLogs: true,
  tokenPricing: {
    input: 3.0, // $3 per 1M input tokens
    output: 15.0, // $15 per 1M output tokens
  },
  metricsWindowSizeMs: 60000, // 1 minute
};

/**
 * 空的 Token 使用量
 */
export const EMPTY_TOKEN_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  total: 0,
};

/**
 * 创建执行日志条目
 */
export function createExecutionLogEntry(
  workflowId: string,
  type: MonitorEventType,
  title: string,
  content: string,
  options?: {
    nodeId?: string;
    level?: 'info' | 'warning' | 'error' | 'debug';
    duration?: number;
    metadata?: Record<string, unknown>;
  }
): ExecutionLogEntry {
  return {
    id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    workflowId,
    nodeId: options?.nodeId,
    type,
    title,
    content,
    timestamp: Date.now(),
    level: options?.level ?? 'info',
    duration: options?.duration,
    metadata: options?.metadata,
  };
}

/**
 * 计算成本
 */
export function calculateCost(
  usage: TokenUsage,
  pricing: { input: number; output: number }
): number {
  const inputCost = (usage.input / 1_000_000) * pricing.input;
  const outputCost = (usage.output / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * 合并 Token 使用量
 */
export function mergeTokenUsage(...usages: TokenUsage[]): TokenUsage {
  return usages.reduce(
    (acc, usage) => ({
      input: acc.input + usage.input,
      output: acc.output + usage.output,
      total: acc.total + usage.total,
    }),
    { ...EMPTY_TOKEN_USAGE }
  );
}
