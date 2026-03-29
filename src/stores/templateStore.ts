/**
 * 模板状态管理
 */

import { create } from 'zustand';
import type { TaskTemplate, CreateTemplateParams } from '../types/taskTemplate';
import * as tauri from '../services/tauri';

/** 内置变量定义 */
export interface BuiltinVariable {
  name: string;
  label: string;
  description: string;
  format?: string;
}

/** 内置变量列表 */
export const BUILTIN_VARIABLES: BuiltinVariable[] = [
  {
    name: 'timestamp',
    label: '时间戳',
    description: '当前 Unix 时间戳（毫秒）',
    format: '{{timestamp}}',
  },
  {
    name: 'datetime',
    label: '日期时间',
    description: '格式化的日期时间',
    format: '{{datetime}}',
  },
  {
    name: 'date',
    label: '日期',
    description: '当前日期',
    format: '{{date}}',
  },
  {
    name: 'time',
    label: '时间',
    description: '当前时间',
    format: '{{time}}',
  },
  {
    name: 'taskId',
    label: '任务 ID',
    description: '当前任务的唯一标识',
    format: '{{taskId}}',
  },
  {
    name: 'taskName',
    label: '任务名称',
    description: '当前任务的名称',
    format: '{{taskName}}',
  },
  {
    name: 'workspacePath',
    label: '工作区路径',
    description: '当前工作区的文件路径',
    format: '{{workspacePath}}',
  },
  {
    name: 'workspaceName',
    label: '工作区名称',
    description: '当前工作区的名称',
    format: '{{workspaceName}}',
  },
  {
    name: 'runCount',
    label: '执行次数',
    description: '任务已执行的次数',
    format: '{{runCount}}',
  },
  {
    name: 'lastRunTime',
    label: '上次执行时间',
    description: '上次执行的日期时间',
    format: '{{lastRunTime}}',
  },
];

interface TemplateState {
  /** 模板列表 */
  templates: TaskTemplate[];
  /** 加载中 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;

  /** 加载模板列表 */
  loadTemplates: () => Promise<void>;
  /** 获取单个模板 */
  getTemplate: (id: string) => TaskTemplate | undefined;
  /** 创建模板 */
  createTemplate: (params: CreateTemplateParams) => Promise<TaskTemplate>;
  /** 更新模板 */
  updateTemplate: (id: string, params: CreateTemplateParams) => Promise<TaskTemplate>;
  /** 删除模板 */
  deleteTemplate: (id: string) => Promise<void>;
  /** 复制模板 */
  duplicateTemplate: (id: string, newName: string) => Promise<TaskTemplate>;
  /** 导出模板 */
  exportTemplate: (id: string) => Promise<string>;
  /** 导入模板 */
  importTemplate: (json: string) => Promise<TaskTemplate>;
}

export const useTemplateStore = create<TemplateState>((set, get) => ({
  templates: [],
  loading: false,
  error: null,

  loadTemplates: async () => {
    set({ loading: true, error: null });
    try {
      const templates = await tauri.templateList();
      set({ templates, loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  getTemplate: (id: string) => {
    return get().templates.find(t => t.id === id);
  },

  createTemplate: async (params: CreateTemplateParams) => {
    const template = await tauri.templateCreate(params);
    set(state => ({ templates: [...state.templates, template] }));
    return template;
  },

  updateTemplate: async (id: string, params: CreateTemplateParams) => {
    const template = await tauri.templateUpdate(id, params);
    set(state => ({
      templates: state.templates.map(t => t.id === id ? template : t),
    }));
    return template;
  },

  deleteTemplate: async (id: string) => {
    await tauri.templateDelete(id);
    set(state => ({
      templates: state.templates.filter(t => t.id !== id),
    }));
  },

  duplicateTemplate: async (id: string, newName: string) => {
    const template = await tauri.templateDuplicate(id, newName);
    set(state => ({ templates: [...state.templates, template] }));
    return template;
  },

  exportTemplate: async (id: string) => {
    return tauri.templateExport(id);
  },

  importTemplate: async (json: string) => {
    const template = await tauri.templateImport(json);
    set(state => ({ templates: [...state.templates, template] }));
    return template;
  },
}));
