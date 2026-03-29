/**
 * 定时任务类型定义（精简版）
 */

/** 触发类型 */
export type TriggerType = 'once' | 'cron' | 'interval';

/** 任务状态 */
export type TaskStatus = 'running' | 'success' | 'failed';

/** 文档配置 */
export interface DocumentConfig {
  /** 是否启用文档模式 */
  enabled: boolean;
  /** 使用的模板 ID */
  templateId?: string;
  /** 主文档类型 */
  primaryDocument: 'task' | 'user' | 'memory' | 'custom';
  /** 自定义变量 */
  customVariables: Record<string, string>;
  /** 文档工作区路径 */
  workspacePath?: string;
}

/** 定时任务（精简版） */
export interface ScheduledTask {
  /** 任务 ID */
  id: string;
  /** 任务名称 */
  name: string;
  /** 是否启用 */
  enabled: boolean;
  /** 触发类型 */
  triggerType: TriggerType;
  /** 触发值 */
  triggerValue: string;
  /** 使用的引擎 ID */
  engineId: string;
  /** 提示词 */
  prompt: string;
  /** 工作目录 */
  workDir?: string;
  /** 任务描述 */
  description?: string;
  /** 上次执行时间 */
  lastRunAt?: number;
  /** 上次执行状态 */
  lastRunStatus?: TaskStatus;
  /** 下次执行时间 */
  nextRunAt?: number;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 所属工作区路径 */
  workspacePath?: string;
  /** 所属工作区名称 */
  workspaceName?: string;
  /** 文档配置 */
  documentConfig?: DocumentConfig;
}

/** 创建任务参数（精简版） */
export interface CreateTaskParams {
  name: string;
  enabled?: boolean;
  triggerType: TriggerType;
  triggerValue: string;
  engineId: string;
  prompt: string;
  workDir?: string;
  description?: string;
  documentConfig?: DocumentConfig;
}

/** 触发类型显示名称 */
export const TriggerTypeLabels: Record<TriggerType, string> = {
  once: '单次执行',
  cron: 'Cron 表达式',
  interval: '间隔执行',
};

/** 间隔单位 */
export type IntervalUnit = 's' | 'm' | 'h' | 'd';

/** 间隔单位显示名称 */
export const IntervalUnitLabels: Record<IntervalUnit, string> = {
  s: '秒',
  m: '分钟',
  h: '小时',
  d: '天',
};

/** 解析间隔表达式 */
export function parseIntervalValue(value: string): { num: number; unit: IntervalUnit } | null {
  const match = value.match(/^(\d+)([smhd])$/);
  if (!match) return null;
  return {
    num: parseInt(match[1], 10),
    unit: match[2] as IntervalUnit,
  };
}

/** 格式化间隔表达式 */
export function formatIntervalValue(num: number, unit: IntervalUnit): string {
  return `${num}${unit}`;
}

// ============================================================================
// 执行详情相关类型
// ============================================================================

/** 执行日志级别 */
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/** 执行日志条目 */
export interface ExecutionLog {
  /** 日志 ID */
  id: string;
  /** 时间戳 (毫秒) */
  timestamp: number;
  /** 日志级别 */
  level: LogLevel;
  /** 日志内容 */
  message: string;
  /** 工具调用信息（可选） */
  toolCall?: {
    name: string;
    args?: Record<string, unknown>;
    result?: unknown;
  };
}

/** 工具调用记录 */
export interface ToolCallRecord {
  /** 工具名称 */
  name: string;
  /** 调用参数 */
  args?: Record<string, unknown>;
  /** 返回结果 */
  result?: unknown;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime?: number;
  /** 是否成功 */
  success?: boolean;
}

/** 执行状态 */
export type ExecutionStatus = 'idle' | 'running' | 'success' | 'failed' | 'cancelled';

/** 任务执行详情 */
export interface TaskExecution {
  /** 任务 ID */
  taskId: string;
  /** 任务名称 */
  taskName: string;
  /** 执行状态 */
  status: ExecutionStatus;
  /** 开始时间 (毫秒) */
  startTime: number;
  /** 结束时间 (毫秒) */
  endTime?: number;
  /** 执行日志 */
  logs: ExecutionLog[];
  /** 工具调用记录 */
  toolCalls: ToolCallRecord[];
  /** 错误信息 */
  error?: string;
}

/** 执行详情视图状态 */
export interface ExecutionViewState {
  /** 当前查看的任务 ID */
  taskId: string | null;
  /** 执行详情 */
  execution: TaskExecution | null;
  /** 是否加载中 */
  loading: boolean;
}
