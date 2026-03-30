/**
 * 定时任务类型定义
 */

// ============ 基础类型 ============

/** 触发类型 */
export type TriggerType = 'once' | 'cron' | 'interval';

/** 任务执行状态 */
export type TaskStatus = 'running' | 'success' | 'failed';

/** 间隔单位 */
export type IntervalUnit = 's' | 'm' | 'h' | 'd';

// ============ 任务模型 ============

/** 定时任务 */
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
  /** 上次执行时间 (Unix 时间戳，秒) */
  lastRunAt?: number;
  /** 上次执行状态 */
  lastRunStatus?: TaskStatus;
  /** 下次执行时间 (Unix 时间戳，秒) */
  nextRunAt?: number;
  /** 创建时间 (Unix 时间戳，秒) */
  createdAt: number;
  /** 更新时间 (Unix 时间戳，秒) */
  updatedAt: number;
  /** 所属工作区路径 */
  workspacePath?: string;
  /** 所属工作区名称 */
  workspaceName?: string;
}

/** 创建任务参数 */
export interface CreateTaskParams {
  /** 任务名称 */
  name: string;
  /** 是否启用 */
  enabled?: boolean;
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
}

// ============ 调度器状态 ============

/** 调度器状态 */
export interface SchedulerStatus {
  /** 调度器是否正在运行 */
  isRunning: boolean;
  /** 当前实例是否持有锁 */
  isHolder: boolean;
  /** 是否有其他实例持有锁 */
  isLockedByOther: boolean;
  /** 当前进程 PID */
  pid: number;
  /** 状态消息 */
  message?: string;
}

// ============ 执行日志 ============

/** 日志条目类型 */
export type LogEntryType =
  | 'session_start'
  | 'message'
  | 'thinking'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'error'
  | 'session_end';

/** 执行日志条目 */
export interface ExecutionLogEntry {
  /** 日志 ID */
  id: string;
  /** 时间戳 (毫秒) */
  timestamp: number;
  /** 日志类型 */
  type: LogEntryType;
  /** 日志内容 */
  content: string;
  /** 额外元数据 */
  metadata?: {
    toolName?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    success?: boolean;
    error?: string;
  };
}

/** 任务执行状态 */
export type ExecutionState = 'idle' | 'running' | 'success' | 'failed';

/** 任务执行信息 */
export interface TaskExecutionInfo {
  /** 任务 ID */
  taskId: string;
  /** 任务名称 */
  taskName: string;
  /** 执行状态 */
  state: ExecutionState;
  /** 开始时间 (毫秒) */
  startTime: number;
  /** 结束时间 (毫秒) */
  endTime?: number;
  /** 日志条目列表 */
  logs: ExecutionLogEntry[];
}

// ============ 事件 ============

/** 任务到期事件 */
export interface TaskDueEvent {
  /** 任务 ID */
  taskId: string;
  /** 任务名称 */
  taskName: string;
  /** 引擎 ID */
  engineId: string;
  /** 工作目录 */
  workDir?: string;
  /** 提示词 */
  prompt: string;
}

// ============ 常量 ============

/** 触发类型标签 */
export const TRIGGER_TYPE_LABELS: Record<TriggerType, string> = {
  once: '单次执行',
  cron: 'Cron 表达式',
  interval: '间隔执行',
};

/** 间隔单位标签 */
export const INTERVAL_UNIT_LABELS: Record<IntervalUnit, string> = {
  s: '秒',
  m: '分钟',
  h: '小时',
  d: '天',
};

/** 任务状态标签 */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  running: '执行中',
  success: '成功',
  failed: '失败',
};

// ============ 工具函数 ============

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

/** 格式化相对时间 */
export function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return '--';
  const now = Date.now() / 1000;
  const diff = timestamp - now;

  if (diff < 0) return '已过期';
  if (diff < 60) return `${Math.floor(diff)} 秒后`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟后`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时后`;
  return `${Math.floor(diff / 86400)} 天后`;
}

/** 格式化日期时间 */
export function formatDateTime(timestamp: number | undefined): string {
  if (!timestamp) return '--';
  const date = new Date(timestamp * 1000);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
