/**
 * 任务文档模板类型定义
 */

/** 变量类型 */
export type VariableType = 'string' | 'number' | 'date' | 'boolean' | 'select';

/** 模板变量定义 */
export interface TemplateVariable {
  /** 变量 ID */
  id: string;
  /** 变量名称 */
  name: string;
  /** 变量类型 */
  type: VariableType;
  /** 默认值 */
  defaultValue?: string;
  /** 是否必填 */
  required?: boolean;
  /** 描述 */
  description?: string;
  /** 选项（type 为 select 时使用） */
  options?: string[];
}

/** 模板文档文件 */
export interface TemplateDocument {
  /** 文件名 */
  filename: string;
  /** 文件内容模板（支持变量占位符 {{variableName}}） */
  content: string;
  /** 是否为主文档（优先传递给 AI） */
  isPrimary?: boolean;
  /** 文件描述 */
  description?: string;
}

/** 任务模板 */
export interface TaskTemplate {
  /** 模板 ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 模板描述 */
  description?: string;
  /** 模板版本 */
  version: string;
  /** 是否为内置模板 */
  builtin: boolean;
  /** 模板图标 */
  icon?: string;
  /** 标签 */
  tags?: string[];
  /** 变量定义 */
  variables: TemplateVariable[];
  /** 文档模板集合 */
  documents: TemplateDocument[];
  /** 默认主文档文件名 */
  primaryDocument: string;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
  /** 作者 */
  author?: string;
}

/** 创建模板参数 */
export interface CreateTemplateParams {
  name: string;
  description?: string;
  variables?: TemplateVariable[];
  documents: TemplateDocument[];
  primaryDocument: string;
  tags?: string[];
}

/** 更新模板参数 */
export interface UpdateTemplateParams {
  name?: string;
  description?: string;
  variables?: TemplateVariable[];
  documents?: TemplateDocument[];
  primaryDocument?: string;
  tags?: string[];
}
