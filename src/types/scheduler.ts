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
  /** 提示词（任务执行的核心指令） */
  prompt: string;
  /** 工作目录 */
  workDir?: string;
  /** 分组名称（可选，未分组则为 undefined） */
  group?: string;
  /** 任务描述/备注（可选，用于记录任务用途、注意事项等） */
  description?: string;
  /** 任务路径（相对于 workDir，用于存储协议文档） */
  taskPath?: string;
  /** 任务目标（用于生成协议文档中的任务目标） */
  mission?: string;
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
  /** 最大执行轮次 (可选，undefined 表示不限) */
  maxRuns?: number;
  /** 当前已执行轮次 */
  currentRuns: number;
  /** 是否复用上次会话 */
  reuseSession: boolean;
  /** 已保存的对话会话 ID */
  conversationSessionId?: string;
  /** 是否成功后立即继续执行 */
  continueImmediately: boolean;
  /** 最大连续执行次数（可选，undefined 表示不限） */
  maxContinuousRuns?: number;
  /** 是否在终端中执行 (便于用户查看过程) */
  runInTerminal: boolean;
  /** 使用的协议模板ID（用于编辑时回显） */
  templateId?: string;
  /** 模板参数值（用于编辑时回显） */
  templateParamValues?: Record<string, string>;
  /** 订阅的上下文 ID（持久化订阅状态，定时执行时会发送事件到该上下文） */
  subscribedContextId?: string;
  /** 最大重试次数（None 或 0 表示不重试） */
  maxRetries?: number;
  /** 当前已重试次数 */
  retryCount: number;
  /** 重试间隔（如 "30s", "5m", "1h"） */
  retryInterval?: string;
  /** 任务完成后是否发送桌面通知 */
  notifyOnComplete?: boolean;
  /** 执行超时时间（分钟，undefined 或 0 表示不限） */
  timeoutMinutes?: number;
  /** 用户补充内容（一次性提示词，每次执行时可以修改） */
  userSupplement?: string;
  /** 任务文档模板（task.md 内容） */
  taskTemplate?: string;
  /** 记忆系统模板（memory/index.md 内容） */
  memoryTemplate?: string;
  /** 任务队列模板（memory/tasks.md 内容） */
  tasksTemplate?: string;
  /** 执行轮次模板（memory/runs.md 内容） */
  runsTemplate?: string;
  /** 用户补充模板（user-supplement.md 内容） */
  supplementTemplate?: string;
  /** 任务是否被阻塞 */
  blocked: boolean;
  /** 阻塞原因 */
  blockedReason?: string;
  /** 当前阶段（分析/设计/开发/测试/修复/验收） */
  currentPhase?: string;
  /** 最近一次有效进展的时间戳 */
  lastEffectiveProgressAt?: number;
  /** 协议版本号 */
  protocolVersion?: number;
  /** 会话最近使用时间 */
  sessionLastUsedAt?: number;
}

/** 执行日志 */
export interface TaskLog {
  /** 日志 ID */
  id: string;
  /** 任务 ID */
  taskId: string;
  /** 任务名称 */
  taskName: string;
  /** 使用的引擎 ID */
  engineId: string;
  /** AI 会话 ID（可用于跳转查看详情） */
  sessionId?: string;
  /** 开始时间 */
  startedAt: number;
  /** 结束时间 */
  finishedAt?: number;
  /** 执行耗时（毫秒） */
  durationMs?: number;
  /** 状态 */
  status: TaskStatus;
  /** 执行时的提示词 */
  prompt: string;
  /** AI 返回内容 */
  output?: string;
  /** 错误信息 */
  error?: string;
  /** 思考过程摘要 */
  thinkingSummary?: string;
  /** 工具调用次数 */
  toolCallCount: number;
  /** Token 消耗 */
  tokenCount?: number;
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
  /** 分组名称（可选） */
  group?: string;
  /** 任务描述/备注（可选，用于记录任务用途、注意事项等） */
  description?: string;
  /** 任务目标（用于生成协议文档） */
  mission?: string;
  /** 最大执行轮次 (可选，undefined 表示不限) */
  maxRuns?: number;
  /** 是否复用上次会话 */
  reuseSession?: boolean;
  /** 是否成功后立即继续执行 */
  continueImmediately?: boolean;
  /** 最大连续执行次数（可选，undefined 表示不限） */
  maxContinuousRuns?: number;
  /** 是否在终端中执行 (便于用户查看过程) */
  runInTerminal?: boolean;
  /** 使用的协议模板ID（用于编辑时回显） */
  templateId?: string;
  /** 模板参数值（用于编辑时回显） */
  templateParamValues?: Record<string, string>;
  /** 最大重试次数（None 或 0 表示不重试） */
  maxRetries?: number;
  /** 重试间隔（如 "30s", "5m", "1h"） */
  retryInterval?: string;
  /** 任务完成后是否发送桌面通知 */
  notifyOnComplete?: boolean;
  /** 执行超时时间（分钟，undefined 或 0 表示不限） */
  timeoutMinutes?: number;
  /** 用户补充内容（一次性提示词，每次执行时可以修改） */
  userSupplement?: string;
  /** 任务文档模板（task.md 内容） */
  taskTemplate?: string;
  /** 记忆系统模板（memory/index.md 内容） */
  memoryTemplate?: string;
  /** 任务队列模板（memory/tasks.md 内容） */
  tasksTemplate?: string;
  /** 执行轮次模板（memory/runs.md 内容） */
  runsTemplate?: string;
  /** 用户补充模板（user-supplement.md 内容） */
  supplementTemplate?: string;
}

/** 协议任务目录结构 */
export interface ProtocolTaskFiles {
  /** 任务 ID */
  taskId: string;
  /** 任务路径 */
  taskPath: string;
  /** 协议文档内容 */
  taskContent: string;
  /** 用户补充文档内容 */
  supplementContent: string;
  /** 记忆索引内容 */
  memoryIndexContent: string;
  /** 记忆任务内容 */
  memoryTasksContent: string;
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

/** 执行任务结果 */
export interface RunTaskResult {
  /** 日志 ID */
  logId: string;
  /** 提示信息 */
  message: string;
}

/** 分页日志结果 */
export interface PaginatedLogs {
  /** 日志列表 */
  logs: TaskLog[];
  /** 总数 */
  total: number;
  /** 当前页（1-indexed） */
  page: number;
  /** 每页大小 */
  pageSize: number;
  /** 总页数 */
  totalPages: number;
}

/** 日志保留配置 */
export interface LogRetentionConfig {
  /** 保留天数（0 表示不限） */
  retentionDays: number;
  /** 每任务最大日志数（0 表示不限） */
  maxLogsPerTask: number;
  /** 是否启用自动清理 */
  autoCleanupEnabled: boolean;
  /** 自动清理间隔（小时） */
  autoCleanupIntervalHours: number;
}

/** 日志统计信息 */
export interface LogStats {
  /** 总日志数 */
  totalLogs: number;
  /** 有日志的任务数 */
  totalTasks: number;
  /** 日志文件大小（字节） */
  totalSizeBytes: number;
  /** 保留配置 */
  retentionConfig: LogRetentionConfig;
  /** 上次清理时间 */
  lastCleanupAt?: number;
}
