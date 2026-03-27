/**
 * 定时任务状态管理
 */

import { create } from 'zustand';
import type { ScheduledTask, TaskLog, TriggerType, CreateTaskParams, RunTaskResult, PaginatedLogs } from '../types/scheduler';
import * as tauri from '../services/tauri';
import type { SubscriptionSession, SubscriptionLogEntry } from '../components/Scheduler/SubscriptionChatPanel';

/** 订阅专用的 contextId */
export const SUBSCRIPTION_CONTEXT_ID = 'scheduler-subscription';

/** 日志分页状态 */
interface LogPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface SchedulerState {
  /** 任务列表 */
  tasks: ScheduledTask[];
  /** 日志列表 */
  logs: TaskLog[];
  /** 日志分页信息 */
  logPagination: LogPagination;
  /** 当前日志筛选的任务 ID */
  logFilterTaskId: string | undefined;
  /** 加载中 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 正在订阅执行的任务 ID（用于在 AI 对话窗口显示） */
  subscribingTaskId: string | null;
  /** 订阅执行的任务名称（用于显示） */
  subscribingTaskName: string | null;

  // ===== 订阅会话管理 =====
  /** 订阅会话列表（任务 ID -> 会话） */
  subscriptionSessions: Record<string, SubscriptionSession>;
  /** 当前活跃的订阅会话 ID */
  activeSubscriptionId: string | null;
  /** 面板是否折叠 */
  isPanelCollapsed: boolean;

  /** 加载任务列表 */
  loadTasks: () => Promise<void>;
  /** 加载日志列表 */
  loadLogs: (limit?: number) => Promise<void>;
  /** 分页加载日志 */
  loadLogsPaginated: (taskId?: string, page?: number, pageSize?: number) => Promise<void>;
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
  initSchedulerEventListener: (getCurrentContextId?: () => string | null | undefined) => () => void;

  // ===== 订阅会话操作 =====
  /** 开始订阅会话 */
  startSubscriptionSession: (taskId: string, taskName: string) => void;
  /** 添加订阅日志 */
  addSubscriptionLog: (taskId: string, entry: Omit<SubscriptionLogEntry, 'id' | 'timestamp'>) => void;
  /** 更新订阅会话状态 */
  updateSubscriptionStatus: (taskId: string, status: SubscriptionSession['status']) => void;
  /** 设置活跃订阅 */
  setActiveSubscription: (taskId: string | null) => void;
  /** 折叠/展开面板 */
  togglePanelCollapse: () => void;
  /** 停止订阅执行 */
  stopSubscription: (taskId: string) => Promise<void>;
  /** 清除订阅会话 */
  clearSubscriptionSession: (taskId: string) => void;
}

// 保存事件监听器清理函数
let schedulerEventCleanup: (() => void) | null = null;

export const useSchedulerStore = create<SchedulerState>((set, get) => ({
  tasks: [],
  logs: [],
  logPagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
  logFilterTaskId: undefined,
  loading: false,
  error: null,
  subscribingTaskId: null,
  subscribingTaskName: null,
  // 订阅会话状态
  subscriptionSessions: {},
  activeSubscriptionId: null,
  isPanelCollapsed: false,

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

  loadLogsPaginated: async (taskId?: string, page: number = 1, pageSize: number = 20) => {
    try {
      set({ loading: true, logFilterTaskId: taskId });
      const result: PaginatedLogs = await tauri.schedulerGetLogsPaginated(taskId, page, pageSize);
      set({
        logs: result.logs,
        logPagination: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          totalPages: result.totalPages,
        },
        loading: false,
      });
    } catch (e) {
      console.error('分页加载日志失败:', e);
      set({ loading: false });
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
        group: params.group,
        mission: params.mission,
        maxRuns: params.maxRuns,
        runInTerminal: params.runInTerminal,
        templateId: params.templateId,
        templateParamValues: params.templateParamValues,
        maxRetries: params.maxRetries,
        retryInterval: params.retryInterval,
        notifyOnComplete: params.notifyOnComplete,
        timeoutMinutes: params.timeoutMinutes,
        userSupplement: params.userSupplement,
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

  runTaskWithSubscription: async (id, taskName, _contextId) => {
    try {
      // 设置订阅状态
      set({ subscribingTaskId: id, subscribingTaskName: taskName });

      // 创建订阅会话并添加初始日志
      get().startSubscriptionSession(id, taskName);
      get().addSubscriptionLog(id, {
        type: 'info',
        content: `开始执行任务: ${taskName}`,
      });

      // 使用独立的 SUBSCRIPTION_CONTEXT_ID，事件将路由到订阅面板而非主对话
      // 注意：忽略传入的 contextId 参数
      const result = await tauri.schedulerRunTaskWithWindow(id, SUBSCRIPTION_CONTEXT_ID);

      // 刷新任务列表获取最新状态
      const tasks = await tauri.schedulerGetTasks();
      set({ tasks });

      // 注意：不清除 subscribingTaskId，等待 task_end 事件
      return result;
    } catch (e) {
      // 更新会话状态为失败
      get().updateSubscriptionStatus(id, 'failed');
      get().addSubscriptionLog(id, {
        type: 'error',
        content: `任务执行失败: ${e instanceof Error ? e.message : String(e)}`,
      });

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

  // ===== 订阅会话操作 =====

  startSubscriptionSession: (taskId, taskName) => {
    const session: SubscriptionSession = {
      taskId,
      taskName,
      startTime: Date.now(),
      status: 'running',
      logs: [],
    };
    set((state) => ({
      subscriptionSessions: {
        ...state.subscriptionSessions,
        [taskId]: session,
      },
      activeSubscriptionId: taskId,
      isPanelCollapsed: false,
    }));
  },

  addSubscriptionLog: (taskId, entry) => {
    const logEntry: SubscriptionLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: Date.now(),
      ...entry,
    };
    set((state) => {
      const session = state.subscriptionSessions[taskId];
      if (!session) return state;
      return {
        subscriptionSessions: {
          ...state.subscriptionSessions,
          [taskId]: {
            ...session,
            logs: [...session.logs, logEntry],
          },
        },
      };
    });
  },

  updateSubscriptionStatus: (taskId, status) => {
    set((state) => {
      const session = state.subscriptionSessions[taskId];
      if (!session) return state;
      return {
        subscriptionSessions: {
          ...state.subscriptionSessions,
          [taskId]: {
            ...session,
            status,
          },
        },
      };
    });
  },

  setActiveSubscription: (taskId) => {
    set({ activeSubscriptionId: taskId });
  },

  togglePanelCollapse: () => {
    set((state) => ({ isPanelCollapsed: !state.isPanelCollapsed }));
  },

  stopSubscription: async (taskId) => {
    // 通过 eventChatStore 中断执行
    try {
      const { useEventChatStore } = await import('./eventChatStore');
      await useEventChatStore.getState().interruptChat();
    } catch (e) {
      console.error('中断任务失败:', e);
    }
    // 更新会话状态
    get().updateSubscriptionStatus(taskId, 'cancelled');
    get().clearSubscription();
  },

  clearSubscriptionSession: (taskId) => {
    set((state) => {
      const { [taskId]: removed, ...rest } = state.subscriptionSessions;
      const newActiveId = state.activeSubscriptionId === taskId
        ? Object.keys(rest)[0] || null
        : state.activeSubscriptionId;
      return {
        subscriptionSessions: rest,
        activeSubscriptionId: newActiveId,
      };
    });
  },

  initSchedulerEventListener: (getCurrentContextId) => {
    // 防止重复监听
    if (schedulerEventCleanup) {
      return schedulerEventCleanup;
    }

    const handleSchedulerEvent = (event: { payload: { type: string; taskId: string; taskName?: string; success?: boolean; contextId?: string; message?: string; eventType?: string } }) => {
      const { type, taskId, taskName, success, message, eventType } = event.payload;
      console.log('[SchedulerStore] 收到 scheduler-event:', type, taskId, success);

      // 获取当前订阅会话
      const session = get().subscriptionSessions[taskId];

      if (type === 'task_start') {
        // 任务开始：创建订阅会话
        if (taskName) {
          get().startSubscriptionSession(taskId, taskName);
          get().addSubscriptionLog(taskId, {
            type: 'info',
            content: `任务开始执行: ${taskName}`,
          });
        }
      } else if (type === 'task_end') {
        // 任务结束：更新会话状态
        if (session) {
          get().addSubscriptionLog(taskId, {
            type: success ? 'result' : 'error',
            content: success ? '任务执行完成' : '任务执行失败',
          });
          get().updateSubscriptionStatus(taskId, success ? 'completed' : 'failed');
        }

        // 清除订阅状态
        const currentSubId = get().subscribingTaskId;
        if (currentSubId === taskId) {
          console.log('[SchedulerStore] 任务结束，清除订阅状态');
          set({ subscribingTaskId: null, subscribingTaskName: null });

          // 刷新任务列表和日志
          get().loadTasks();
          get().loadLogs(50);

          // 自动续订优化：更新订阅的 contextId 为 SUBSCRIPTION_CONTEXT_ID
          // 这样下次定时触发时，事件将路由到订阅面板而非主对话窗口
          if (success && getCurrentContextId) {
            console.log('[SchedulerStore] 自动续订：更新 contextId 为 SUBSCRIPTION_CONTEXT_ID');
            tauri.schedulerSubscribeTask(taskId, SUBSCRIPTION_CONTEXT_ID).catch((e) => {
              console.warn('[SchedulerStore] 更新订阅 contextId 失败:', e);
            });
          }
        }
      } else if (type === 'task_progress' || type === 'task_log') {
        // 任务进度/日志：添加日志
        if (session && message) {
          const logType: 'info' | 'tool' | 'thinking' | 'result' | 'error' | 'warning' =
            eventType === 'tool' ? 'tool' :
            eventType === 'thinking' ? 'thinking' :
            eventType === 'error' ? 'error' :
            eventType === 'warning' ? 'warning' :
            eventType === 'result' ? 'result' : 'info';
          get().addSubscriptionLog(taskId, {
            type: logType,
            content: message,
          });
        }
      } else if (type === 'task_due') {
        // 任务到期且有订阅，自动调用 runTaskWithSubscription
        console.log('[SchedulerStore] 收到 task_due 事件，自动执行订阅任务:', taskId, taskName);

        // 设置订阅状态
        set({ subscribingTaskId: taskId, subscribingTaskName: taskName || null });

        // 创建订阅会话
        if (taskName) {
          get().startSubscriptionSession(taskId, taskName);
        }

        // 使用独立的 SUBSCRIPTION_CONTEXT_ID
        tauri.schedulerRunTaskWithWindow(taskId, SUBSCRIPTION_CONTEXT_ID).catch((e) => {
          console.error('[SchedulerStore] 自动执行订阅任务失败:', e);
          set({ subscribingTaskId: null, subscribingTaskName: null });
          if (taskName) {
            get().updateSubscriptionStatus(taskId, 'failed');
            get().addSubscriptionLog(taskId, {
              type: 'error',
              content: `执行失败: ${e}`,
            });
          }
        });
      }
    };

    // 监听 scheduler-event 事件
    const unlisten = tauri.listen<{ type: string; taskId: string; taskName?: string; success?: boolean; contextId?: string; message?: string; eventType?: string }>(
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
