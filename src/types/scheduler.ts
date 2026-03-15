/**
 * 定时任务类型定义
 */

/** 触发类型 */
export type TriggerType = 'once' | 'cron' | 'interval';

/** 任务状态 */
export type TaskStatus = 'running' | 'success' | 'failed';

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
}

/** 执行日志 */
export interface TaskLog {
  /** 日志 ID */
  id: string;
  /** 任务 ID */
  taskId: string;
  /** 任务名称 */
  taskName: string;
  /** 开始时间 */
  startedAt: number;
  /** 结束时间 */
  finishedAt?: number;
  /** 状态 */
  status: TaskStatus;
  /** 执行时的提示词 */
  prompt: string;
  /** AI 返回内容 */
  output?: string;
  /** 错误信息 */
  error?: string;
}

/** 创建任务参数 */
export interface CreateTaskParams {
  name: string;
  enabled?: boolean;
  triggerType: TriggerType;
  triggerValue: string;
  engineId: string;
  prompt: string;
  workDir?: string;
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

/** 调度器锁状态 */
export interface LockStatus {
  /** 当前实例是否持有锁 */
  isHolder: boolean;
  /** 是否有其他实例持有锁 */
  isLockedByOther: boolean;
  /** 当前进程 PID */
  pid: number;
}
