/**
 * 定时任务状态管理
 */

import { create } from 'zustand';
import type { ScheduledTask, TaskLog, TriggerType, CreateTaskParams, RunTaskResult } from '../types/scheduler';
import * as tauri from '../services/tauri';

interface SchedulerState {
  /** 任务列表 */
  tasks: ScheduledTask[];
  /** 日志列表 */
  logs: TaskLog[];
  /** 加载中 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;

  /** 加载任务列表 */
  loadTasks: () => Promise<void>;
  /** 加载日志列表 */
  loadLogs: (limit?: number) => Promise<void>;
  /** 创建任务 */
  createTask: (params: CreateTaskParams) => Promise<ScheduledTask>;
  /** 更新任务 */
  updateTask: (task: ScheduledTask) => Promise<void>;
  /** 删除任务 */
  deleteTask: (id: string) => Promise<void>;
  /** 切换任务启用状态 */
  toggleTask: (id: string, enabled: boolean) => Promise<void>;
  /** 立即执行任务 */
  runTask: (id: string) => Promise<RunTaskResult>;
  /** 验证触发表达式 */
  validateTrigger: (type: TriggerType, value: string) => Promise<number | null>;
  /** 清理过期日志 */
  cleanupLogs: () => Promise<void>;
}

export const useSchedulerStore = create<SchedulerState>((set) => ({
  tasks: [],
  logs: [],
  loading: false,
  error: null,

  loadTasks: async () => {
    set({ loading: true, error: null });
    try {
      const tasks = await tauri.schedulerGetTasks();
      set({ tasks, loading: false });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : '加载任务失败',
        loading: false,
      });
    }
  },

  loadLogs: async (limit?: number) => {
    try {
      const logs = await tauri.schedulerGetAllLogs(limit);
      set({ logs });
    } catch (e) {
      console.error('加载日志失败:', e);
    }
  },

  createTask: async (params) => {
    set({ loading: true, error: null });
    try {
      const task = await tauri.schedulerCreateTask({
        name: params.name,
        enabled: params.enabled ?? true,
        triggerType: params.triggerType,
        triggerValue: params.triggerValue,
        engineId: params.engineId,
        prompt: params.prompt,
        workDir: params.workDir,
        mode: params.mode,
        mission: params.mission,
        maxRuns: params.maxRuns,
      });

      // 刷新列表
      const tasks = await tauri.schedulerGetTasks();
      set({ tasks, loading: false });

      return task;
    } catch (e) {
      const error = e instanceof Error ? e.message : '创建任务失败';
      set({ error, loading: false });
      throw new Error(error);
    }
  },

  updateTask: async (task) => {
    set({ loading: true, error: null });
    try {
      await tauri.schedulerUpdateTask(task);

      // 刷新列表
      const tasks = await tauri.schedulerGetTasks();
      set({ tasks, loading: false });
    } catch (e) {
      const error = e instanceof Error ? e.message : '更新任务失败';
      set({ error, loading: false });
      throw new Error(error);
    }
  },

  deleteTask: async (id) => {
    set({ loading: true, error: null });
    try {
      await tauri.schedulerDeleteTask(id);

      // 刷新列表
      const tasks = await tauri.schedulerGetTasks();
      set({ tasks, loading: false });
    } catch (e) {
      const error = e instanceof Error ? e.message : '删除任务失败';
      set({ error, loading: false });
      throw new Error(error);
    }
  },

  toggleTask: async (id, enabled) => {
    try {
      await tauri.schedulerToggleTask(id, enabled);

      // 更新本地状态
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === id ? { ...t, enabled } : t
        ),
      }));
    } catch (e) {
      console.error('切换任务状态失败:', e);
    }
  },

  runTask: async (id) => {
    try {
      const result = await tauri.schedulerRunTask(id);

      // 刷新任务列表获取最新状态
      const tasks = await tauri.schedulerGetTasks();
      set({ tasks });

      return result;
    } catch (e) {
      console.error('执行任务失败:', e);
      throw e;
    }
  },

  validateTrigger: async (type, value) => {
    try {
      return await tauri.schedulerValidateTrigger(type, value);
    } catch (e) {
      console.error('验证触发表达式失败:', e);
      return null;
    }
  },

  cleanupLogs: async () => {
    try {
      await tauri.schedulerCleanupLogs();
      // 刷新日志
      const logs = await tauri.schedulerGetAllLogs();
      set({ logs });
    } catch (e) {
      console.error('清理日志失败:', e);
    }
  },
}));
