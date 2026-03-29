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
}

export const useSchedulerStore = create<SchedulerState>((set) => ({
  tasks: [],
  loading: false,
  error: null,
  lockStatus: null,
  lockLoading: false,

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
}));
