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
  /** 完整文档模板（支持占位符）- 完整 task.md 内容模板 */
  fullTemplate?: string;
  /** 模板参数定义 - 用于动态生成输入框 */
  templateParams?: TemplateParam[];
  /** 协议文档模板（可选，支持占位符） */
  protocolTemplate?: string;
  /** 记忆系统模板 - memory/index.md 内容模板 */
  memoryTemplate?: string;
  /** 任务队列模板 - memory/tasks.md 内容模板 */
  tasksTemplate?: string;
  /** 执行轮次模板 - memory/runs.md 内容模板 */
  runsTemplate?: string;
  /** 用户补充模板 - user-supplement.md 内容模板 */
  supplementTemplate?: string;
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
  /** 记忆系统模板 */
  memoryTemplate?: string;
  /** 任务队列模板 */
  tasksTemplate?: string;
  /** 执行轮次模板 */
  runsTemplate?: string;
  /** 用户补充模板 */
  supplementTemplate?: string;
  defaultTriggerType?: 'once' | 'cron' | 'interval';
  defaultTriggerValue?: string;
  defaultEngineId?: string;
}

/** 内置模板定义 */
export const BUILTIN_PROTOCOL_TEMPLATES: ProtocolTemplate[] = [
  {
    id: 'protocol-assist',
    name: '协议协助模式',
    description: '完整的协议任务模板，支持任务目标、记忆系统和用户补充内容',
    category: 'development',
    builtin: true,
    missionTemplate: '{task}',
    fullTemplate: `# 任务协议

> 任务ID: {taskId}
> 创建时间: {dateTime}
> 版本: 1.0.0

---

## 任务目标

{task}

---

## 工作区

\`\`\`
{workDir}
\`\`\`

---

## 执行规则

每次触发时按以下顺序执行：

### 1. 检查用户补充
- 读取 \`.polaris/tasks/{timestamp}/user-supplement.md\`
- 如有新内容，优先处理并归档

### 2. 推进主任务
- 读取 \`.polaris/tasks/{timestamp}/memory/index.md\` 了解当前进度
- 选择下一个待办事项执行
- 完成后更新记忆

### 3. 记忆更新
- 新成果写入 \`.polaris/tasks/{timestamp}/memory/index.md\`
- 待办任务写入 \`.polaris/tasks/{timestamp}/memory/tasks.md\`

### 4. 文档备份
- 用户补充处理完成后迁移到 \`.oprcli/tasks/{timestamp}/supplement-history/\`
- 文档超过 800 行时总结后备份

---

## 补充

1. 分析后无需用户审查
2. 修改内容后及时提交git
3. 将任务拆分处理，每次完成一部分，当任务都完成后，就测试，审查，优化，改造

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
    memoryTemplate: `# 成果索引

## 当前状态
状态: 初始化
进度: 0%

## 已完成
- [暂无]

## 进行中
- [暂无]
`,
    tasksTemplate: `# 任务队列

## 待办
1. 分析任务目标：{task}
2. 拆解为可执行步骤
3. 逐步推进

## 已完成
- [暂无]
`,
    runsTemplate: `# 执行轮次记录

## Run 1
- 时间: [待记录]
- 使用会话: [待记录]
- 完成事项: [待记录]
- 遗留事项: [待记录]
- 是否触发连续执行: 否
`,
    supplementTemplate: `# 用户补充

> 用于临时调整任务方向或补充要求
> AI 处理后会清空内容，历史记录保存在 .oprcli/tasks/{timestamp}/supplement-history/

---

<!-- 在下方添加补充内容 -->




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
  taskId: '{taskId}',
  workDir: '{workDir}',
  timestamp: '{timestamp}',
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
  taskId?: string;
  workDir?: string;
  timestamp?: string;
  [key: string]: string | undefined;
}

/** 渲染完整模板 - 支持所有占位符 */
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

/** 渲染模板集 - 返回 task.md、memory/index.md、memory/tasks.md、memory/runs.md、user-supplement.md 内容 */
export interface RenderedTemplateSet {
  /** task.md 内容 */
  taskContent: string;
  /** memory/index.md 内容 */
  memoryContent: string;
  /** memory/tasks.md 内容 */
  tasksContent: string;
  /** memory/runs.md 内容 */
  runsContent: string;
  /** user-supplement.md 内容 */
  supplementContent: string;
}

/** 渲染完整模板集 */
export function renderTemplateSet(
  template: ProtocolTemplate,
  params: TemplateParamValues
): RenderedTemplateSet {
  const baseParams: TemplateParamValues = {
    ...params,
    taskId: params.taskId || 'auto-generated',
    timestamp: params.timestamp || Date.now().toString(),
  };

  return {
    taskContent: template.fullTemplate
      ? renderFullTemplate(template.fullTemplate, baseParams)
      : `# 任务协议\n\n## 任务目标\n\n${params.task || params.mission || ''}`,
    memoryContent: template.memoryTemplate
      ? renderFullTemplate(template.memoryTemplate, baseParams)
      : `# 成果索引\n\n## 当前状态\n状态: 初始化\n进度: 0%\n`,
    tasksContent: template.tasksTemplate
      ? renderFullTemplate(template.tasksTemplate, baseParams)
      : `# 任务队列\n\n## 待办\n1. 分析任务目标\n\n## 已完成\n- [暂无]\n`,
    runsContent: template.runsTemplate
      ? renderFullTemplate(template.runsTemplate, baseParams)
      : `# 执行轮次记录\n\n## Run 1\n- 时间: [待记录]\n- 使用会话: [待记录]\n- 完成事项: [待记录]\n- 遗留事项: [待记录]\n- 是否触发连续执行: 否\n`,
    supplementContent: template.supplementTemplate
      ? renderFullTemplate(template.supplementTemplate, baseParams)
      : `# 用户补充\n\n<!-- 在下方添加补充内容 -->\n\n`,
  };
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
