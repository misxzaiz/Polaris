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
  /** 正在订阅执行的任务 ID（用于在 AI 对话窗口显示） */
  subscribingTaskId: string | null;
  /** 订阅执行的任务名称（用于显示） */
  subscribingTaskName: string | null;

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
  /** 立即执行任务（订阅模式 - 发送事件到 AI 对话窗口） */
  runTaskWithSubscription: (id: string, taskName: string, contextId?: string) => Promise<RunTaskResult>;
  /** 订阅任务（持久化订阅状态） */
  subscribeTask: (id: string, contextId: string) => Promise<void>;
  /** 取消订阅任务 */
  unsubscribeTask: (id: string) => Promise<void>;
  /** 验证触发表达式 */
  validateTrigger: (type: TriggerType, value: string) => Promise<number | null>;
  /** 清理过期日志 */
  cleanupLogs: () => Promise<void>;
  /** 清除订阅状态（任务完成时调用） */
  clearSubscription: () => void;
  /** 初始化监听 scheduler-event 事件 */
  initSchedulerEventListener: () => () => void;
}

// 保存事件监听器清理函数
let schedulerEventCleanup: (() => void) | null = null;

export const useSchedulerStore = create<SchedulerState>((set, get) => ({
  tasks: [],
  logs: [],
  loading: false,
  error: null,
  subscribingTaskId: null,
  subscribingTaskName: null,

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
        runInTerminal: params.runInTerminal,
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

  runTaskWithSubscription: async (id, taskName, contextId) => {
    try {
      // 设置订阅状态
      set({ subscribingTaskId: id, subscribingTaskName: taskName });

      const result = await tauri.schedulerRunTaskWithWindow(id, contextId);

      // 刷新任务列表获取最新状态
      const tasks = await tauri.schedulerGetTasks();
      set({ tasks });

      // 注意：不清除 subscribingTaskId，等待 task_end 事件
      return result;
    } catch (e) {
      set({ subscribingTaskId: null, subscribingTaskName: null });
      console.error('执行任务（订阅模式）失败:', e);
      throw e;
    }
  },

  subscribeTask: async (id, contextId) => {
    try {
      await tauri.schedulerSubscribeTask(id, contextId);
      // 刷新任务列表获取最新状态
      const tasks = await tauri.schedulerGetTasks();
      set({ tasks });
    } catch (e) {
      console.error('订阅任务失败:', e);
      throw e;
    }
  },

  unsubscribeTask: async (id) => {
    try {
      await tauri.schedulerUnsubscribeTask(id);
      // 清除本地订阅状态
      set({ subscribingTaskId: null, subscribingTaskName: null });
      // 刷新任务列表获取最新状态
      const tasks = await tauri.schedulerGetTasks();
      set({ tasks });
    } catch (e) {
      console.error('取消订阅任务失败:', e);
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

  clearSubscription: () => {
    set({ subscribingTaskId: null, subscribingTaskName: null });
  },

  initSchedulerEventListener: () => {
    // 防止重复监听
    if (schedulerEventCleanup) {
      return schedulerEventCleanup;
    }

    const handleSchedulerEvent = (event: { payload: { type: string; taskId: string; taskName?: string; success?: boolean; contextId?: string } }) => {
      const { type, taskId, taskName, success, contextId } = event.payload;
      console.log('[SchedulerStore] 收到 scheduler-event:', type, taskId, success);

      if (type === 'task_end') {
        // 任务结束时清除订阅状态
        const currentSubId = get().subscribingTaskId;
        if (currentSubId === taskId) {
          console.log('[SchedulerStore] 任务结束，清除订阅状态');
          set({ subscribingTaskId: null, subscribingTaskName: null });

          // 刷新任务列表和日志
          get().loadTasks();
          get().loadLogs(50);
        }
      } else if (type === 'task_due') {
        // 任务到期且有订阅，自动调用 runTaskWithSubscription
        console.log('[SchedulerStore] 收到 task_due 事件，自动执行订阅任务:', taskId, taskName);

        // 设置订阅状态
        set({ subscribingTaskId: taskId, subscribingTaskName: taskName || null });

        // 调用 runTaskWithSubscription
        tauri.schedulerRunTaskWithWindow(taskId, contextId).catch((e) => {
          console.error('[SchedulerStore] 自动执行订阅任务失败:', e);
          set({ subscribingTaskId: null, subscribingTaskName: null });
        });
      }
    };

    // 监听 scheduler-event 事件
    const unlisten = tauri.listen<{ type: string; taskId: string; taskName?: string; success?: boolean; contextId?: string }>(
      'scheduler-event',
      (event) => handleSchedulerEvent(event)
    );

    schedulerEventCleanup = () => {
      unlisten.then((fn) => fn());
      schedulerEventCleanup = null;
    };

    return schedulerEventCleanup;
  },
}));
