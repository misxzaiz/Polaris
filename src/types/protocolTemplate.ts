/**
 * 文档模式模板类型定义
 *
 * 用于协议模式任务的模板系统，支持内置模板和用户自定义模板
 */

/** 模板类别 */
export type ProtocolTemplateCategory = 'development' | 'optimization' | 'fix' | 'custom';

/** 模板类别标签 */
export const ProtocolTemplateCategoryLabels: Record<ProtocolTemplateCategory, string> = {
  development: '开发任务',
  optimization: '优化任务',
  fix: '修复任务',
  custom: '自定义',
};

/** 协议模式模板 */
export interface ProtocolTemplate {
  /** 模板 ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 模板描述 */
  description: string;
  /** 模板类别 */
  category: ProtocolTemplateCategory;
  /** 是否为内置模板 */
  builtin: boolean;
  /** 任务目标模板（支持占位符）- 保留向后兼容 */
  missionTemplate: string;
  /** 完整文档模板（支持占位符）- 新增：完整 task.md 内容模板 */
  fullTemplate?: string;
  /** 模板参数定义 - 新增：用于动态生成输入框 */
  templateParams?: TemplateParam[];
  /** 协议文档模板（可选，支持占位符） */
  protocolTemplate?: string;
  /** 默认触发类型 */
  defaultTriggerType?: 'once' | 'cron' | 'interval';
  /** 默认触发值 */
  defaultTriggerValue?: string;
  /** 默认引擎 */
  defaultEngineId?: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
}

/** 创建模板参数 */
export interface CreateProtocolTemplateParams {
  name: string;
  description: string;
  category: ProtocolTemplateCategory;
  missionTemplate: string;
  fullTemplate?: string;
  templateParams?: TemplateParam[];
  protocolTemplate?: string;
  defaultTriggerType?: 'once' | 'cron' | 'interval';
  defaultTriggerValue?: string;
  defaultEngineId?: string;
}

/** 内置模板定义 */
export const BUILTIN_PROTOCOL_TEMPLATES: ProtocolTemplate[] = [
  {
    id: 'protocol-assist',
    name: '协议协助模式',
    description: '完整的协议任务模板，支持任务目标和用户补充内容',
    category: 'development',
    builtin: true,
    missionTemplate: '{task}', // 向后兼容
    fullTemplate: `# 任务协议

> 任务ID: 自动生成
> 创建时间: {dateTime}
> 版本: 1.0.0

---

## 任务目标

{task}

---

## 用户补充

{userSupplement}

---

## 执行规则

每次触发时按以下顺序执行：

### 1. 检查用户补充
- 读取用户补充文件
- 如有新内容，优先处理并归档

### 2. 推进主任务
- 读取记忆索引了解当前进度
- 选择下一个待办事项执行
- 完成后更新记忆

### 3. 记忆更新
- 新成果写入记忆文件
- 待办任务写入任务文件

---

## 成果定义

有价值的工作：
- 完成具体功能实现
- 修复已知问题
- 优化代码质量
- 产出可复用资产

避免：
- 无产出的探索
- 重复性工作
`,
    templateParams: [
      {
        key: 'task',
        label: '任务目标',
        type: 'textarea',
        required: true,
        placeholder: '描述任务目标...',
      },
    ],
    defaultTriggerType: 'interval',
    defaultTriggerValue: '1h',
    defaultEngineId: 'claude',
    createdAt: 0,
    updatedAt: 0,
  },
];

/** 模板参数定义 - 用于动态生成输入框 */
export interface TemplateParam {
  /** 参数键，用于占位符匹配，如 "task", "userSupplement" */
  key: string;
  /** 显示标签 */
  label: string;
  /** 输入类型 */
  type: 'text' | 'textarea' | 'select';
  /** 是否必填 */
  required: boolean;
  /** 默认值 */
  default?: string;
  /** 占位提示 */
  placeholder?: string;
  /** select 类型的选项 */
  options?: { value: string; label: string }[];
}

/** 支持的占位符 */
export const TEMPLATE_PLACEHOLDERS = {
  dateTime: '{dateTime}',
  mission: '{mission}',
  date: '{date}',
  time: '{time}',
  task: '{task}',
  userSupplement: '{userSupplement}',
};

/** 格式化日期时间 */
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

/** 格式化日期 */
export function formatDateForTemplate(): string {
  const now = new Date();
  return now.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/** 格式化时间 */
export function formatTimeForTemplate(): string {
  const now = new Date();
  return now.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 渲染模板的参数 */
export interface RenderTemplateParams {
  /** 任务目标/描述 (对应 {mission} 和 {task}) */
  mission?: string;
  /** 用户补充内容 (对应 {userSupplement}) */
  userSupplement?: string;
}

/** 渲染模板 */
export function renderProtocolTemplate(
  template: string,
  missionOrParams: string | RenderTemplateParams
): string {
  let result = template;

  // 兼容旧的字符串参数形式
  const params: RenderTemplateParams = typeof missionOrParams === 'string'
    ? { mission: missionOrParams }
    : missionOrParams;

  // 替换基础占位符
  result = result.replace(TEMPLATE_PLACEHOLDERS.dateTime, formatDateTimeForTemplate());
  result = result.replace(TEMPLATE_PLACEHOLDERS.date, formatDateForTemplate());
  result = result.replace(TEMPLATE_PLACEHOLDERS.time, formatTimeForTemplate());

  // 替换任务相关占位符
  result = result.replace(TEMPLATE_PLACEHOLDERS.mission, params.mission || '');
  result = result.replace(TEMPLATE_PLACEHOLDERS.task, params.mission || '');
  result = result.replace(TEMPLATE_PLACEHOLDERS.userSupplement, params.userSupplement || '');

  return result;
}

/** 渲染参数映射类型 */
export interface TemplateParamValues {
  task?: string;
  userSupplement?: string;
  mission?: string;
  [key: string]: string | undefined;
}

/** 渲染完整模板 - 新版，支持所有占位符 */
export function renderFullTemplate(
  template: string,
  params: TemplateParamValues
): string {
  let result = template;

  // 替换系统占位符
  result = result.replace(TEMPLATE_PLACEHOLDERS.dateTime, formatDateTimeForTemplate());
  result = result.replace(TEMPLATE_PLACEHOLDERS.date, formatDateForTemplate());
  result = result.replace(TEMPLATE_PLACEHOLDERS.time, formatTimeForTemplate());

  // 替换用户参数占位符
  Object.entries(params).forEach(([key, value]) => {
    const placeholder = `{${key}}`;
    if (result.includes(placeholder)) {
      result = result.split(placeholder).join(value || '');
    }
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
