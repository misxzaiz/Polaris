/**
 * 文档工作区状态管理
 */

import { create } from 'zustand';
import type {
  DocumentWorkspace,
  CreateWorkspaceParams,
  RenderResult,
  VariableInstance,
  WorkspaceDocument,
} from '../types/documentWorkspace';
import * as tauri from '../services/tauri';

interface DocumentState {
  /** 当前工作区 */
  currentWorkspace: DocumentWorkspace | null;
  /** 加载中 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;

  /** 加载工作区 */
  loadWorkspace: (taskId: string) => Promise<void>;
  /** 创建工作区 */
  createWorkspace: (params: CreateWorkspaceParams) => Promise<DocumentWorkspace>;
  /** 更新工作区 */
  updateWorkspace: (
    documents?: WorkspaceDocument[],
    variables?: VariableInstance[]
  ) => Promise<void>;
  /** 删除工作区 */
  deleteWorkspace: (taskId: string) => Promise<void>;
  /** 更新单个文档 */
  updateDocument: (filename: string, content: string) => Promise<void>;
  /** 添加用户补充 */
  addUserSupplement: (content: string) => Promise<void>;
  /** 归档用户补充 */
  archiveUserSupplement: () => Promise<void>;
  /** 渲染文档 */
  renderDocuments: (
    taskId: string,
    taskName: string,
    workspacePath?: string,
    workspaceName?: string,
    runCount?: number,
    lastRunTime?: number
  ) => Promise<RenderResult>;
  /** 记录执行摘要 */
  recordExecution: (
    taskId: string,
    status: string,
    duration?: number,
    summary?: string
  ) => Promise<void>;
  /** 清除当前工作区 */
  clearWorkspace: () => void;
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  currentWorkspace: null,
  loading: false,
  error: null,

  loadWorkspace: async (taskId: string) => {
    set({ loading: true, error: null });
    try {
      const workspace = await tauri.documentGetWorkspace(taskId);
      set({ currentWorkspace: workspace, loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  createWorkspace: async (params: CreateWorkspaceParams) => {
    const workspace = await tauri.documentCreateWorkspace(params);
    set({ currentWorkspace: workspace });
    return workspace;
  },

  updateWorkspace: async (
    documents?: WorkspaceDocument[],
    variables?: VariableInstance[]
  ) => {
    const current = get().currentWorkspace;
    if (!current) return;

    const workspace = await tauri.documentUpdateWorkspace(
      current.taskId,
      documents,
      variables
    );
    set({ currentWorkspace: workspace });
  },

  deleteWorkspace: async (taskId: string) => {
    await tauri.documentDeleteWorkspace(taskId);
    const current = get().currentWorkspace;
    if (current?.taskId === taskId) {
      set({ currentWorkspace: null });
    }
  },

  updateDocument: async (filename: string, content: string) => {
    const current = get().currentWorkspace;
    if (!current) return;

    const workspace = await tauri.documentUpdate(current.taskId, filename, content);
    set({ currentWorkspace: workspace });
  },

  addUserSupplement: async (content: string) => {
    const current = get().currentWorkspace;
    if (!current) return;

    const workspace = await tauri.documentAddUserSupplement(current.taskId, content);
    set({ currentWorkspace: workspace });
  },

  archiveUserSupplement: async () => {
    const current = get().currentWorkspace;
    if (!current) return;

    const workspace = await tauri.documentArchiveUserSupplement(current.taskId);
    set({ currentWorkspace: workspace });
  },

  renderDocuments: async (
    taskId: string,
    taskName: string,
    workspacePath?: string,
    workspaceName?: string,
    runCount?: number,
    lastRunTime?: number
  ) => {
    return tauri.documentRender(
      taskId,
      taskName,
      workspacePath,
      workspaceName,
      runCount,
      lastRunTime
    );
  },

  recordExecution: async (
    taskId: string,
    status: string,
    duration?: number,
    summary?: string
  ) => {
    const workspace = await tauri.documentRecordExecution(
      taskId,
      status,
      duration,
      summary
    );
    const current = get().currentWorkspace;
    if (current?.taskId === taskId) {
      set({ currentWorkspace: workspace });
    }
  },

  clearWorkspace: () => {
    set({ currentWorkspace: null });
  },
}));
