/**
 * 快捷片段类型定义
 */

/** 片段变量类型 */
export type SnippetVarType = 'text' | 'textarea';

/** 片段变量定义 */
export interface SnippetVariable {
  /** 变量键名（对应模板中的 {{key}}） */
  key: string;
  /** 显示标签 */
  label: string;
  /** 变量类型 */
  type: SnippetVarType;
  /** 是否必填 */
  required: boolean;
  /** 默认值 */
  defaultValue?: string;
  /** 占位提示 */
  placeholder?: string;
}

/** 快捷片段 */
export interface PromptSnippet {
  id: string;
  name: string;
  description?: string;
  /** 模板内容，支持 {{variable}} 占位符 */
  content: string;
  /** 用户定义的变量列表 */
  variables: SnippetVariable[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 创建片段参数 */
export interface CreateSnippetParams {
  name: string;
  description?: string;
  content: string;
  variables: SnippetVariable[];
  enabled?: boolean;
}

/** 更新片段参数 */
export interface UpdateSnippetParams {
  name?: string;
  description?: string;
  content?: string;
  variables?: SnippetVariable[];
  enabled?: boolean;
}

/** 自动注入变量（系统提供，无需用户填写） */
export const AUTO_VARIABLES = [
  { key: 'date', label: '当前日期', description: 'YYYY-MM-DD' },
  { key: 'time', label: '当前时间', description: 'HH:MM' },
  { key: 'workspaceName', label: '工作区名称', description: '当前工作区' },
  { key: 'workspacePath', label: '工作区路径', description: '当前工作区路径' },
] as const;

/** 从模板内容中提取用户变量占位符（排除自动变量） */
export function extractVariables(content: string): string[] {
  const matches = content.match(/\{\{(\w+)\}\}/g);
  if (!matches) return [];
  const vars = [...new Set(matches.map(m => m.slice(2, -2)))];
  const autoKeys: string[] = AUTO_VARIABLES.map(v => v.key);
  return vars.filter(v => !autoKeys.includes(v));
}
