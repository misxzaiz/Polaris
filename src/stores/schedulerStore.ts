/**
 * 定时任务状态管理（精简版）
 */

import { create } from 'zustand';
import type { ScheduledTask, TriggerType, CreateTaskParams } from '../types/scheduler';
import * as tauri from '../services/tauri';
import type { LockStatus } from '../services/tauri';

interface SchedulerState {
  /** 任务列表 */
  tasks: ScheduledTask[];
  /** 加载中 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 锁状态 */
  lockStatus: LockStatus | null;
  /** 锁操作加载中 */
  lockLoading: boolean;
  /** 正在执行的任务 ID 集合 */
  runningTaskIds: Set<string>;

  /** 加载任务列表 */
  loadTasks: () => Promise<void>;
  /** 创建任务 */
  createTask: (params: CreateTaskParams) => Promise<ScheduledTask>;
  /** 更新任务 */
  updateTask: (task: ScheduledTask) => Promise<void>;
  /** 删除任务 */
  deleteTask: (id: string) => Promise<void>;
  /** 切换任务启用状态 */
  toggleTask: (id: string, enabled: boolean) => Promise<void>;
  /** 验证触发表达式 */
  validateTrigger: (type: TriggerType, value: string) => Promise<number | null>;
  /** 获取锁状态 */
  loadLockStatus: () => Promise<void>;
  /** 获取锁 */
  acquireLock: () => Promise<boolean>;
  /** 释放锁 */
  releaseLock: () => Promise<void>;
  /** 手动触发任务执行 */
  runTask: (id: string) => Promise<ScheduledTask>;
  /** 更新任务执行结果 */
  updateRunStatus: (id: string, status: 'success' | 'failed') => Promise<void>;
  /** 检查任务是否正在执行 */
  isTaskRunning: (id: string) => boolean;
}

export const useSchedulerStore = create<SchedulerState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  lockStatus: null,
  lockLoading: false,
  runningTaskIds: new Set<string>(),

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

  createTask: async (params) => {
    set({ loading: true, error: null });
    try {
      const task = await tauri.schedulerCreateTask(params);

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

  validateTrigger: async (type, value) => {
    try {
      return await tauri.schedulerValidateTrigger(type, value);
    } catch (e) {
      console.error('验证触发表达式失败:', e);
      return null;
    }
  },

  loadLockStatus: async () => {
    try {
      const lockStatus = await tauri.schedulerGetLockStatus();
      set({ lockStatus });
    } catch (e) {
      console.error('获取锁状态失败:', e);
    }
  },

  acquireLock: async () => {
    set({ lockLoading: true });
    try {
      const success = await tauri.schedulerAcquireLock();
      // 刷新锁状态
      const lockStatus = await tauri.schedulerGetLockStatus();
      set({ lockStatus, lockLoading: false });
      return success;
    } catch (e) {
      console.error('获取锁失败:', e);
      set({ lockLoading: false });
      return false;
    }
  },

  releaseLock: async () => {
    set({ lockLoading: true });
    try {
      await tauri.schedulerReleaseLock();
      // 刷新锁状态
      const lockStatus = await tauri.schedulerGetLockStatus();
      set({ lockStatus, lockLoading: false });
    } catch (e) {
      console.error('释放锁失败:', e);
      set({ lockLoading: false });
    }
  },

  runTask: async (id) => {
    // 标记任务为执行中
    set((state) => {
      const newRunningTaskIds = new Set(state.runningTaskIds);
      newRunningTaskIds.add(id);
      return { runningTaskIds: newRunningTaskIds };
    });

    try {
      const task = await tauri.schedulerRunTask(id);

      // 更新本地任务状态
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === id ? { ...t, lastRunStatus: 'running' as const, lastRunAt: Date.now() / 1000 } : t
        ),
      }));

      return task;
    } catch (e) {
      // 执行失败，移除执行中状态
      set((state) => {
        const newRunningTaskIds = new Set(state.runningTaskIds);
        newRunningTaskIds.delete(id);
        return { runningTaskIds: newRunningTaskIds };
      });
      throw e;
    }
  },

  updateRunStatus: async (id, status) => {
    try {
      await tauri.schedulerUpdateRunStatus(id, status);

      // 更新本地状态
      set((state) => {
        const newRunningTaskIds = new Set(state.runningTaskIds);
        newRunningTaskIds.delete(id);
        return {
          runningTaskIds: newRunningTaskIds,
          tasks: state.tasks.map((t) =>
            t.id === id ? { ...t, lastRunStatus: status } : t
          ),
        };
      });
    } catch (e) {
      console.error('更新任务执行状态失败:', e);
    }
  },

  isTaskRunning: (id) => {
    return get().runningTaskIds.has(id);
  },
}));
