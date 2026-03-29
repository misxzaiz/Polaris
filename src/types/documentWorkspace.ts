/**
 * 文档工作区类型定义
 */

/** 文档类型 */
export type DocumentType = 'task' | 'user' | 'memory' | 'custom';

/** 工作区文档 */
export interface WorkspaceDocument {
  /** 文件名 */
  filename: string;
  /** 文档类型 */
  type: DocumentType;
  /** 文档内容 */
  content: string;
  /** 是否为主文档 */
  isPrimary: boolean;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
}

/** 变量实例值 */
export interface VariableInstance {
  /** 变量 ID（对应模板变量） */
  variableId: string;
  /** 变量名 */
  name: string;
  /** 当前值 */
  value: string;
  /** 是否来自模板 */
  fromTemplate: boolean;
}

/** 执行摘要 */
export interface ExecutionSummary {
  /** 执行时间 */
  timestamp: string;
  /** 执行状态 */
  status: 'success' | 'failed' | 'cancelled';
  /** 执行时长（秒） */
  duration?: number;
  /** 简要说明 */
  summary?: string;
  /** 是否有用户补充 */
  hasUserSupplement?: boolean;
}

/** 文档工作区 */
export interface DocumentWorkspace {
  /** 工作区 ID（与任务 ID 相同） */
  id: string;
  /** 关联的任务 ID */
  taskId: string;
  /** 使用的模板 ID（可选） */
  templateId?: string;
  /** 文档列表 */
  documents: WorkspaceDocument[];
  /** 主文档文件名 */
  primaryDocument: string;
  /** 变量实例 */
  variables: VariableInstance[];
  /** 执行历史摘要 */
  executionHistory: ExecutionSummary[];
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
}

/** 创建工作区参数 */
export interface CreateWorkspaceParams {
  taskId: string;
  templateId?: string;
  initialVariables?: Record<string, string>;
}

/** 更新工作区参数 */
export interface UpdateWorkspaceParams {
  templateId?: string;
  documents?: WorkspaceDocument[];
  primaryDocument?: string;
  variables?: VariableInstance[];
}

/** 渲染后的文档 */
export interface RenderedDocument {
  filename: string;
  content: string;
  isPrimary: boolean;
}

/** 渲染结果 */
export interface RenderResult {
  documents: RenderedDocument[];
  variables: Record<string, string>;
  primaryDocument: RenderedDocument | null;
}
