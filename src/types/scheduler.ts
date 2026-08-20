/**
 * 定时任务类型定义
 */

// ============ 基础类型 ============

/** 触发类型 */
export type TriggerType = 'once' | 'cron' | 'interval' | 'after_completion';

/** 任务执行状态 */
export type TaskStatus = 'running' | 'success' | 'failed';

/** 间隔单位 */
export type IntervalUnit = 's' | 'm' | 'h' | 'd';

/** 任务模式 */
export type TaskMode = 'simple' | 'protocol';

/** 任务分类 */
export type TaskCategory = 'development' | 'review' | 'news' | 'monitor' | 'custom';

// ============ 协议模板类型 ============

/** 模板参数类型 */
export type TemplateParamType = 'text' | 'textarea' | 'select' | 'number' | 'date';

/** 模板选择选项 */
export interface SelectOption {
  /** 选项值 */
  value: string;
  /** 选项标签 */
  label: string;
}

/** 协议模板参数定义 */
export interface TemplateParam {
  /** 参数键（用于占位符匹配） */
  key: string;
  /** 显示标签 */
  label: string;
  /** 参数类型 */
  type: TemplateParamType;
  /** 是否必填 */
  required: boolean;
  /** 默认值 */
  defaultValue?: string;
  /** 占位提示 */
  placeholder?: string;
  /** 选择选项（select 类型使用） */
  options?: SelectOption[];
}

/** 区块位置 */
export type SectionPosition = 'beforeRules' | 'afterRules' | 'afterMemory';

/** 自定义区块 */
export interface CustomSection {
  /** 区块标题 */
  title: string;
  /** 区块模板内容 */
  template: string;
  /** 区块位置 */
  position?: SectionPosition;
}

/** 协议模板配置 */
export interface ProtocolTemplateConfig {
  /** 任务目标模板 */
  missionTemplate: string;
  /** 执行规则模板（可选） */
  executionRules?: string;
  /** 记忆规则模板（可选） */
  memoryRules?: string;
  /** 自定义区块模板（可选） */
  customSections?: CustomSection[];
}

/** 协议任务模板 */
export interface ProtocolTemplate {
  /** 模板 ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 模板描述 */
  description?: string;
  /** 模板分类 */
  category: TaskCategory;
  /** 是否为内置模板 */
  builtin: boolean;
  /** 协议模板配置 */
  protocolConfig: ProtocolTemplateConfig;
  /** 提示词模板（用于生成最终 prompt） */
  promptTemplate?: string;
  /** 模板参数定义 */
  params: TemplateParam[];
  /** 默认触发类型 */
  defaultTriggerType?: TriggerType;
  /** 默认触发值 */
  defaultTriggerValue?: string;
  /** 默认引擎 ID */
  defaultEngineId?: string;
  /** 默认最大执行次数 */
  defaultMaxRuns?: number;
  /** 默认超时时间（分钟） */
  defaultTimeoutMinutes?: number;
  /** 是否启用 */
  enabled: boolean;
  /** 创建时间 (Unix 时间戳，秒) */
  createdAt: number;
  /** 更新时间 (Unix 时间戳，秒) */
  updatedAt: number;
}

/** 创建协议模板参数 */
export interface CreateProtocolTemplateParams {
  /** 模板名称 */
  name: string;
  /** 模板描述 */
  description?: string;
  /** 模板分类 */
  category: TaskCategory;
  /** 协议模板配置 */
  protocolConfig: ProtocolTemplateConfig;
  /** 提示词模板 */
  promptTemplate?: string;
  /** 模板参数定义 */
  params?: TemplateParam[];
  /** 默认触发类型 */
  defaultTriggerType?: TriggerType;
  /** 默认触发值 */
  defaultTriggerValue?: string;
  /** 默认引擎 ID */
  defaultEngineId?: string;
  /** 默认最大执行次数 */
  defaultMaxRuns?: number;
  /** 默认超时时间 */
  defaultTimeoutMinutes?: number;
  /** 是否启用 */
  enabled?: boolean;
}

/** 协议模板存储 */
export interface ProtocolTemplateStore {
  version: string;
  templates: ProtocolTemplate[];
}

// ============ 提示词模板（简单模式） ============

/** 提示词模板 */
export interface PromptTemplate {
  /** 模板 ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 模板描述 */
  description?: string;
  /** 模板内容，支持占位符：{{prompt}}, {{taskName}}, {{date}}, {{time}}, {{datetime}}, {{weekday}} */
  content: string;
  /** 是否启用 */
  enabled: boolean;
  /** 创建时间 (Unix 时间戳，秒) */
  createdAt: number;
  /** 更新时间 (Unix 时间戳，秒) */
  updatedAt: number;
}

/** 创建模板参数 */
export interface CreateTemplateParams {
  /** 模板名称 */
  name: string;
  /** 模板描述 */
  description?: string;
  /** 模板内容 */
  content: string;
  /** 是否启用 */
  enabled?: boolean;
}

/** 模板支持的变量 */
export const TEMPLATE_VARIABLES = [
  { key: '{{prompt}}', description: '用户输入的提示词' },
  { key: '{{taskName}}', description: '任务名称' },
  { key: '{{date}}', description: '当前日期 (YYYY-MM-DD)' },
  { key: '{{time}}', description: '当前时间 (HH:MM)' },
  { key: '{{datetime}}', description: '当前日期时间 (YYYY-MM-DD HH:MM)' },
  { key: '{{weekday}}', description: '星期几 (中文)' },
] as const;

// ============ 任务模型 ============

/** 定时任务 */
export interface ScheduledTask {
  // === 基础属性 ===
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
  /** 提示词 (simple 模式使用) */
  prompt: string;
  /** 工作目录 */
  workDir?: string;
  /** 任务描述 */
  description?: string;

  // === 状态属性 ===
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

  // === 工作区关联 ===
  /** 所属工作区路径 */
  workspacePath?: string;
  /** 所属工作区名称 */
  workspaceName?: string;

  // === 任务模式 ===
  /** 任务模式 */
  mode: TaskMode;
  /** 任务分类 */
  category: TaskCategory;

  // === 协议模式属性 ===
  /** 任务文档路径 (protocol 模式) */
  taskPath?: string;
  /** 任务目标 (protocol 模式) */
  mission?: string;
  /** 模板 ID */
  templateId?: string;
  /** 模板参数 */
  templateParams?: Record<string, string>;

  // === 执行控制 ===
  /** 最大执行次数 (protocol 模式) */
  maxRuns?: number;
  /** 当前执行次数 */
  currentRuns: number;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 当前重试次数 */
  retryCount: number;
  /** 重试间隔 */
  retryInterval?: string;
  /** 超时时间（分钟） */
  timeoutMinutes?: number;

  // === 其他 ===
  /** 分组 */
  group?: string;
  /** 完成通知 */
  notifyOnComplete: boolean;
}

/** 创建任务参数 */
export interface CreateTaskParams {
  // === 基础属性 ===
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
  /** 提示词 (simple 模式使用) */
  prompt: string;
  /** 工作目录 */
  workDir?: string;
  /** 任务描述 */
  description?: string;

  // === 工作区关联 ===
  /** 所属工作区路径 */
  workspacePath?: string;
  /** 所属工作区名称 */
  workspaceName?: string;

  // === 任务模式 ===
  /** 任务模式 */
  mode?: TaskMode;
  /** 任务分类 */
  category?: TaskCategory;

  // === 协议模式属性 ===
  /** 任务目标 (protocol 模式) */
  mission?: string;
  /** 模板 ID */
  templateId?: string;
  /** 模板参数 */
  templateParams?: Record<string, string>;

  // === 执行控制 ===
  /** 最大执行次数 (protocol 模式) */
  maxRuns?: number;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 重试间隔 */
  retryInterval?: string;
  /** 超时时间（分钟） */
  timeoutMinutes?: number;

  // === 其他 ===
  /** 分组 */
  group?: string;
  /** 完成通知 */
  notifyOnComplete?: boolean;
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
  /** 提示词（简单模式使用） */
  prompt: string;
  /** 模板 ID */
  templateId?: string;
  /** 任务模式 */
  mode: TaskMode;
  /** 协议任务路径（协议模式使用） */
  taskPath?: string;
  /** 任务目标（协议模式使用） */
  mission?: string;
}

// ============ 常量 ============

/** 触发类型标签 */
export const TRIGGER_TYPE_LABELS: Record<TriggerType, string> = {
  once: '单次执行',
  cron: 'Cron 表达式',
  interval: '间隔执行',
  after_completion: '完成后间隔',
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

/** 任务模式标签 */
export const TASK_MODE_LABELS: Record<TaskMode, string> = {
  simple: '简单模式',
  protocol: '协议模式',
};

/** 任务分类标签 */
export const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = {
  development: '开发任务',
  review: '审查任务',
  news: '新闻搜索',
  monitor: '监控任务',
  custom: '自定义',
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

// ============ 协议文档 ============

/** 协议文档内容 */
export interface ProtocolDocuments {
  /** 协议文档 */
  protocol: string;
  /** 用户补充 */
  supplement: string;
  /** 记忆索引 */
  memoryIndex: string;
  /** 记忆任务 */
  memoryTasks: string;
}

// ============ 协议模板工具函数 ============

/** 格式化日期时间（用于模板） */
export function formatDateTimeForTemplate(): string {
  const now = new Date();
  return now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 格式化日期（用于模板） */
export function formatDateForTemplate(): string {
  const now = new Date();
  return now.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/** 格式化时间（用于模板） */
export function formatTimeForTemplate(): string {
  const now = new Date();
  return now.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 渲染协议模板 */
export function renderProtocolTemplate(
  template: string,
  params: Record<string, string>
): string {
  let result = template;

  // 替换系统占位符
  result = result.replace(/{dateTime}/g, formatDateTimeForTemplate());
  result = result.replace(/{date}/g, formatDateForTemplate());
  result = result.replace(/{time}/g, formatTimeForTemplate());

  // 替换用户参数占位符
  Object.entries(params).forEach(([key, value]) => {
    const placeholder = `{${key}}`;
    result = result.split(placeholder).join(value || '');
  });

  return result;
}

/** 从模板中提取占位符列表 */
export function extractPlaceholders(template: string): string[] {
  const regex = /\{(\w+)\}/g;
  const placeholders: string[] = [];
  let match;
  while ((match = regex.exec(template)) !== null) {
    if (!placeholders.includes(match[1])) {
      placeholders.push(match[1]);
    }
  }
  return placeholders;
}

/** 生成协议文档 */
export function generateProtocolDocument(
  template: ProtocolTemplate,
  params: Record<string, string>
): string {
  const now = new Date();
  const dateTime = now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  // 渲染任务目标
  const mission = renderProtocolTemplate(template.protocolConfig.missionTemplate, params);

  let doc = `# 任务协议

> 任务ID: {taskId}
> 创建时间: ${dateTime}
> 模板类型: ${template.category}
> 版本: 1.0.0

---

## 任务目标

${mission}

---

## 工作区

\`\`\`
{workspacePath}
\`\`\`

---

## 执行规则

${template.protocolConfig.executionRules || '按需执行任务'}
`;

  // 添加自定义区块
  if (template.protocolConfig.customSections) {
    for (const section of template.protocolConfig.customSections) {
      const content = renderProtocolTemplate(section.template, params);
      doc += `\n---\n\n## ${section.title}\n\n${content}\n`;
    }
  }

  // 添加记忆规则
  if (template.protocolConfig.memoryRules) {
    const rules = renderProtocolTemplate(template.protocolConfig.memoryRules, params);
    doc += `\n---\n\n${rules}\n`;
  }

  // 添加补充部分
  doc += `\n---\n\n## 补充\n\n> 用于临时调整任务方向或补充要求\n`;

  // 添加协议更新说明
  doc += `\n---\n\n## 协议更新\n\n可修改本协议，修改时记录：\n- 修改内容\n- 修改原因\n- 预期效果\n`;

  return doc;
}

