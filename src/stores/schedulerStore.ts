/**
 * 定时任务状态管理
 */

import { create } from 'zustand';
import type {
  ScheduledTask,
  CreateTaskParams,
  TriggerType,
  SchedulerStatus,
  TaskDueEvent,
  ExecutionLogEntry,
  TaskExecutionInfo,
  ExecutionState,
} from '../types/scheduler';
import * as tauri from '../services/tauri';

/** 日志数量限制 */
const MAX_LOG_ENTRIES = 20;

/** 生成唯一 ID */
function generateLogId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

interface SchedulerState {
  // === 任务列表 ===
  /** 任务列表 */
  tasks: ScheduledTask[];
  /** 加载中 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;

  // === 调度器状态 ===
  /** 调度器状态 */
  schedulerStatus: SchedulerStatus | null;
  /** 状态操作加载中 */
  statusLoading: boolean;

  // === 执行状态 ===
  /** 正在执行的任务 ID 集合 */
  runningTaskIds: Set<string>;
  /** 任务执行信息 Map */
  executions: Map<string, TaskExecutionInfo>;
  /** 当前查看的任务 ID */
  activeTaskId: string | null;
  /** 抽屉是否展开 */
  drawerOpen: boolean;

  // === 操作方法 ===
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

  // === 调度器生命周期 ===
  /** 加载调度器状态 */
  loadSchedulerStatus: () => Promise<void>;
  /** 启动调度器 */
  startScheduler: () => Promise<boolean>;
  /** 停止调度器 */
  stopScheduler: () => Promise<boolean>;

  // === 任务执行 ===
  /** 手动触发任务执行 */
  runTask: (id: string) => Promise<ScheduledTask>;
  /** 更新任务执行结果 */
  updateRunStatus: (id: string, status: 'success' | 'failed') => Promise<void>;
  /** 检查任务是否正在执行 */
  isTaskRunning: (id: string) => boolean;
  /** 处理任务到期事件 */
  handleTaskDue: (event: TaskDueEvent) => Promise<void>;

  // === 执行日志 ===
  /** 添加日志条目 */
  addLog: (taskId: string, entry: Omit<ExecutionLogEntry, 'id' | 'timestamp'>) => void;
  /** 清空任务日志 */
  clearLogs: (taskId: string) => void;
  /** 关闭任务执行 Tab */
  closeExecutionTab: (taskId: string) => void;
  /** 设置当前查看的任务 */
  setActiveTask: (taskId: string | null) => void;
  /** 设置抽屉展开状态 */
  setDrawerOpen: (open: boolean) => void;
  /** 获取任务执行信息 */
  getExecution: (taskId: string) => TaskExecutionInfo | undefined;
  /** 获取所有执行中的任务 */
  getExecutingTasks: () => TaskExecutionInfo[];
}

export const useSchedulerStore = create<SchedulerState>((set, get) => ({
  // === 初始状态 ===
  tasks: [],
  loading: false,
  error: null,
  schedulerStatus: null,
  statusLoading: false,
  runningTaskIds: new Set<string>(),
  executions: new Map<string, TaskExecutionInfo>(),
  activeTaskId: null,
  drawerOpen: false,

  // === 任务列表操作 ===

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

  // === 调度器生命周期 ===

  loadSchedulerStatus: async () => {
    try {
      const schedulerStatus = await tauri.schedulerGetStatus();
      set({ schedulerStatus });
    } catch (e) {
      console.error('获取调度器状态失败:', e);
    }
  },

  startScheduler: async () => {
    set({ statusLoading: true });
    try {
      const schedulerStatus = await tauri.schedulerStart();
      set({ schedulerStatus, statusLoading: false });
      return schedulerStatus.isRunning;
    } catch (e) {
      console.error('启动调度器失败:', e);
      set({ statusLoading: false });
      return false;
    }
  },

  stopScheduler: async () => {
    set({ statusLoading: true });
    try {
      const schedulerStatus = await tauri.schedulerStop();
      set({ schedulerStatus, statusLoading: false });
      return true;
    } catch (e) {
      console.error('停止调度器失败:', e);
      set({ statusLoading: false });
      return false;
    }
  },

  // === 任务执行 ===

  runTask: async (id) => {
    const store = get();

    // 标记任务为执行中
    set((state) => {
      const newRunningTaskIds = new Set(state.runningTaskIds);
      newRunningTaskIds.add(id);
      return { runningTaskIds: newRunningTaskIds };
    });

    // 获取任务名称
    const task = store.tasks.find((t) => t.id === id);

    // 初始化执行信息
    set((state) => {
      const newExecutions = new Map(state.executions);
      newExecutions.set(id, {
        taskId: id,
        taskName: task?.name || '未知任务',
        state: 'running',
        startTime: Date.now(),
        logs: [],
      });
      return { executions: newExecutions };
    });

    // 如果是第一个执行的任务，自动打开抽屉并设置为活动任务
    const isFirstTask = store.runningTaskIds.size === 0;
    if (isFirstTask) {
      set({ drawerOpen: true, activeTaskId: id });
    }

    // 添加开始日志
    get().addLog(id, {
      type: 'session_start',
      content: '开始执行任务...',
    });

    try {
      const result = await tauri.schedulerRunTask(id);

      // 更新本地任务状态
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === id ? { ...t, lastRunStatus: 'running' as const, lastRunAt: Date.now() / 1000 } : t
        ),
      }));

      return result;
    } catch (e) {
      // 执行失败
      set((state) => {
        const newRunningTaskIds = new Set(state.runningTaskIds);
        newRunningTaskIds.delete(id);
        return { runningTaskIds: newRunningTaskIds };
      });

      get().addLog(id, {
        type: 'error',
        content: e instanceof Error ? e.message : '任务启动失败',
      });

      throw e;
    }
  },

  updateRunStatus: async (id, status) => {
    try {
      await tauri.schedulerUpdateRunStatus(id, status);

      set((state) => {
        const newRunningTaskIds = new Set(state.runningTaskIds);
        newRunningTaskIds.delete(id);

        // 更新执行状态
        const newExecutions = new Map(state.executions);
        const execution = newExecutions.get(id);
        if (execution) {
          execution.state = status as ExecutionState;
          execution.endTime = Date.now();
        }

        return {
          runningTaskIds: newRunningTaskIds,
          executions: newExecutions,
          tasks: state.tasks.map((t) =>
            t.id === id ? { ...t, lastRunStatus: status } : t
          ),
        };
      });

      // 添加结束日志
      get().addLog(id, {
        type: 'session_end',
        content: status === 'success' ? '任务执行完成' : '任务执行失败',
        metadata: { success: status === 'success' },
      });
    } catch (e) {
      console.error('更新任务执行状态失败:', e);
    }
  },

  isTaskRunning: (id) => {
    return get().runningTaskIds.has(id);
  },

  handleTaskDue: async (event) => {
    const { taskId, engineId, workDir, prompt } = event;
    const store = get();

    if (store.runningTaskIds.has(taskId)) {
      console.log('[Scheduler] 任务已在执行中，跳过:', taskId);
      return;
    }

    try {
      await store.runTask(taskId);

      const { invoke } = await import('@tauri-apps/api/core');
      const sessionId = await invoke<string>('start_chat', {
        message: prompt,
        options: {
          workDir,
          contextId: `scheduler-${taskId}`,
          engineId,
          enableMcpTools: engineId === 'claude-code',
        },
      });

      console.log('[Scheduler] 任务执行会话 ID:', sessionId);
    } catch (e) {
      console.error('[Scheduler] 任务执行失败:', e);
      await get().updateRunStatus(taskId, 'failed');
    }
  },

  // === 执行日志 ===

  addLog: (taskId, entry) => {
    set((state) => {
      const newExecutions = new Map(state.executions);
      const execution = newExecutions.get(taskId);

      if (!execution) return state;

      const newLog: ExecutionLogEntry = {
        id: generateLogId(),
        timestamp: Date.now(),
        ...entry,
      };

      // 限制日志数量
      const logs = [...execution.logs, newLog];
      if (logs.length > MAX_LOG_ENTRIES) {
        logs.splice(0, logs.length - MAX_LOG_ENTRIES);
      }

      execution.logs = logs;
      return { executions: newExecutions };
    });
  },

  clearLogs: (taskId) => {
    set((state) => {
      const newExecutions = new Map(state.executions);
      const execution = newExecutions.get(taskId);

      if (execution) {
        execution.logs = [];
      }

      return { executions: newExecutions };
    });
  },

  closeExecutionTab: (taskId) => {
    set((state) => {
      const newExecutions = new Map(state.executions);
      newExecutions.delete(taskId);

      // 如果关闭的是当前活动任务，切换到其他任务
      let newActiveTaskId = state.activeTaskId;
      if (state.activeTaskId === taskId) {
        const remainingTasks = Array.from(newExecutions.keys());
        newActiveTaskId = remainingTasks.length > 0 ? remainingTasks[0] : null;
      }

      return {
        executions: newExecutions,
        activeTaskId: newActiveTaskId,
        drawerOpen: newExecutions.size > 0 ? state.drawerOpen : false,
      };
    });
  },

  setActiveTask: (taskId) => {
    set({ activeTaskId: taskId });
  },

  setDrawerOpen: (open) => {
    set({ drawerOpen: open });
  },

  getExecution: (taskId) => {
    return get().executions.get(taskId);
  },

  getExecutingTasks: () => {
    const state = get();
    return Array.from(state.executions.values());
  },
}));
