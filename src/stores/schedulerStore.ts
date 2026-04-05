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
  LogEntryType,
  PromptTemplate,
  CreateTemplateParams,
  ProtocolTemplate,
  CreateProtocolTemplateParams,
  TaskCategory,
} from '../types/scheduler';
import * as tauri from '../services/tauri';
import { getEventRouter } from '../services/eventRouter';
import { extractErrorMessage } from '../utils/errorMapping';

/** 日志数量限制 */
const MAX_LOG_ENTRIES = 20;

/** 生成唯一 ID */
function generateLogId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 解析 AI 事件为日志 */
function parseEventToLog(event: Record<string, unknown>): {
  type: LogEntryType;
  content: string;
  metadata?: Record<string, unknown>;
} | null {
  const type = event.type as string | undefined;

  switch (type) {
    case 'session_start':
      return { type: 'session_start', content: '开始执行任务...' };

    case 'progress':
      return { type: 'message', content: (event.message as string) || '处理中...' };

    case 'thinking':
      return { type: 'thinking', content: (event.content as string) || '思考中...' };

    case 'assistant_message':
    case 'assistant':
      return { type: 'message', content: (event.content as string) || '' };

    case 'tool_call_start':
      const toolName = (event.tool as string) || (event.toolName as string) || (event.name as string) || 'unknown';
      return {
        type: 'tool_call_start',
        content: `调用工具: ${toolName}`,
        metadata: { toolName, args: event.args },
      };

    case 'tool_call_end':
      const endToolName = (event.tool as string) || (event.toolName as string) || (event.name as string) || 'unknown';
      const success = event.success !== false;
      return {
        type: 'tool_call_end',
        content: success ? `${endToolName} 完成` : `${endToolName} 失败`,
        metadata: { toolName: endToolName, success },
      };

    case 'session_end':
      const reason = event.reason as string | undefined;
      if (reason === 'error' || reason === 'failed') {
        return {
          type: 'error',
          content: (event.error as string) || '执行失败',
        };
      }
      return { type: 'session_end', content: '任务执行完成', metadata: { success: true } };

    case 'error':
      return { type: 'error', content: (event.error as string) || (event.message as string) || '未知错误' };

    default:
      return null;
  }
}

/** 事件订阅存储 */
const eventSubscriptions = new Map<string, () => void>();

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
  /** 已订阅日志的任务 ID 集合 */
  subscribedTaskIds: Set<string>;
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
  runTask: (id: string, options?: { subscribe?: boolean }) => Promise<ScheduledTask>;
  /** 更新任务执行结果 */
  updateRunStatus: (id: string, status: 'success' | 'failed') => Promise<void>;
  /** 检查任务是否正在执行 */
  isTaskRunning: (id: string) => boolean;
  /** 处理任务到期事件 */
  handleTaskDue: (event: TaskDueEvent) => Promise<void>;

  // === 事件订阅 ===
  /** 订阅任务事件 */
  subscribeToEvents: (taskId: string) => Promise<void>;
  /** 取消订阅任务事件 */
  unsubscribeFromEvents: (taskId: string) => void;
  /** 检查任务是否已订阅 */
  isTaskSubscribed: (id: string) => boolean;

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

  // === 模板管理 ===
  /** 模板列表 */
  templates: PromptTemplate[];
  /** 模板加载中 */
  templatesLoading: boolean;
  /** 加载模板列表 */
  loadTemplates: () => Promise<void>;
  /** 创建模板 */
  createTemplate: (params: CreateTemplateParams) => Promise<PromptTemplate>;
  /** 更新模板 */
  updateTemplate: (template: PromptTemplate) => Promise<PromptTemplate>;
  /** 删除模板 */
  deleteTemplate: (id: string) => Promise<void>;
  /** 切换模板启用状态 */
  toggleTemplate: (id: string, enabled: boolean) => Promise<void>;
  /** 构建提示词（应用模板） */
  buildPrompt: (templateId: string, taskName: string, userPrompt: string) => Promise<string>;

  // === 协议模板管理 ===
  /** 协议模板列表 */
  protocolTemplates: ProtocolTemplate[];
  /** 协议模板加载中 */
  protocolTemplatesLoading: boolean;
  /** 加载协议模板列表 */
  loadProtocolTemplates: () => Promise<void>;
  /** 按分类加载协议模板 */
  loadProtocolTemplatesByCategory: (category: TaskCategory) => Promise<void>;
  /** 获取单个协议模板 */
  getProtocolTemplate: (id: string) => Promise<ProtocolTemplate | null>;
  /** 创建协议模板 */
  createProtocolTemplate: (params: CreateProtocolTemplateParams) => Promise<ProtocolTemplate>;
  /** 更新协议模板 */
  updateProtocolTemplate: (id: string, params: CreateProtocolTemplateParams) => Promise<ProtocolTemplate | null>;
  /** 删除协议模板 */
  deleteProtocolTemplate: (id: string) => Promise<boolean>;
  /** 切换协议模板启用状态 */
  toggleProtocolTemplate: (id: string, enabled: boolean) => Promise<void>;
  /** 使用模板生成协议文档 */
  renderProtocolDocument: (template: ProtocolTemplate, params: Record<string, string>) => Promise<string>;
}

export const useSchedulerStore = create<SchedulerState>((set, get) => ({
  // === 初始状态 ===
  tasks: [],
  loading: false,
  error: null,
  schedulerStatus: null,
  statusLoading: false,
  runningTaskIds: new Set<string>(),
  subscribedTaskIds: new Set<string>(),
  executions: new Map<string, TaskExecutionInfo>(),
  activeTaskId: null,
  drawerOpen: false,
  templates: [],
  templatesLoading: false,
  protocolTemplates: [],
  protocolTemplatesLoading: false,

  // === 任务列表操作 ===

  loadTasks: async () => {
    set({ loading: true, error: null });
    try {
      const tasks = await tauri.schedulerGetTasks();
      set({ tasks, loading: false });
    } catch (e) {
      const error = extractErrorMessage(e);
      set({ error: error || 'scheduler.errors.loadTasksFailed', loading: false });
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
      const error = extractErrorMessage(e);
      set({ error: error || 'scheduler.errors.createTaskFailed', loading: false });
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
      const error = extractErrorMessage(e);
      set({ error: error || 'scheduler.errors.updateTaskFailed', loading: false });
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
      const error = extractErrorMessage(e);
      set({ error: error || 'scheduler.errors.deleteTaskFailed', loading: false });
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
      const error = extractErrorMessage(e);
      console.error('切换任务状态失败:', error);
      throw new Error(error);
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

  runTask: async (id, options) => {
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

    // 如果需要订阅，注册事件处理器
    if (options?.subscribe) {
      await get().subscribeToEvents(id);
    }

    try {
      const result = await tauri.schedulerRunTask(id);

      // 更新本地任务状态（时间戳使用整数，与后端 i64 一致）
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === id ? { ...t, lastRunStatus: 'running' as const, lastRunAt: Math.floor(Date.now() / 1000) } : t
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
    } catch (e) {
      console.error('更新任务执行状态失败:', e);
    }
  },

  isTaskRunning: (id) => {
    return get().runningTaskIds.has(id);
  },

  handleTaskDue: async (event) => {
    const { taskId, engineId, workDir, prompt, taskName, templateId, mode, taskPath } = event;

    // 调试日志：记录事件详情
    console.log('[Scheduler] TaskDue Event:', {
      taskId,
      taskName,
      mode,
      taskPath,
      workDir,
      promptLength: prompt?.length ?? 0,
      missionLength: event.mission?.length ?? 0,
      templateId,
      engineId,
    });

    const store = get();

    if (store.runningTaskIds.has(taskId)) {
      console.log('[Scheduler] 任务已在执行中，跳过:', taskId);
      return;
    }

    try {
      // 执行任务（不订阅日志）
      await store.runTask(taskId, { subscribe: false });

      // 构建最终提示词
      let finalPrompt = prompt;

      // 协议模式：从文档构建 prompt
      if (mode === 'protocol') {
        console.log('[Scheduler] 协议模式，检查路径:', { taskPath, workDir });

        if (taskPath && workDir) {
          try {
            finalPrompt = await tauri.schedulerBuildProtocolPrompt(taskPath, workDir);
            console.log('[Scheduler] 协议模式，构建的 prompt 长度:', finalPrompt?.length ?? 0);
          } catch (e) {
            console.error('[Scheduler] 构建协议 prompt 失败:', e);
            // 使用 mission 作为备用
            finalPrompt = event.mission || prompt || '';
            console.log('[Scheduler] 使用备用 prompt，长度:', finalPrompt?.length ?? 0);
          }
        } else {
          console.error('[Scheduler] 协议模式缺少 taskPath 或 workDir，使用备用 prompt');
          finalPrompt = event.mission || prompt || '';
          console.log('[Scheduler] 备用 prompt 来源:', {
            hasMission: !!event.mission,
            hasPrompt: !!prompt,
            finalLength: finalPrompt?.length ?? 0,
          });
        }
      } else if (templateId) {
        // 简单模式 + 模板
        try {
          finalPrompt = await store.buildPrompt(templateId, taskName, prompt);
          console.log('[Scheduler] 已应用模板，最终提示词长度:', finalPrompt?.length ?? 0);
        } catch (e) {
          console.error('[Scheduler] 应用模板失败，使用原始提示词:', e);
        }
      } else {
        // 简单模式无模板
        console.log('[Scheduler] 简单模式，原始 prompt 长度:', finalPrompt?.length ?? 0);
      }

      // 检查 prompt 是否为空
      if (!finalPrompt || finalPrompt.trim().length === 0) {
        console.error('[Scheduler] 提示词为空，无法执行任务', {
          mode,
          taskPath,
          workDir,
          hasPrompt: !!prompt,
          hasMission: !!event.mission,
          hasTemplateId: !!templateId,
        });
        get().addLog(taskId, {
          type: 'error',
          content: '提示词为空，无法执行任务',
        });
        await get().updateRunStatus(taskId, 'failed');
        return;
      }

      // 调用 AI 引擎
      const { invoke } = await import('@tauri-apps/api/core');
      const sessionId = await invoke<string>('start_chat', {
        message: finalPrompt,
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

  // === 事件订阅 ===

  subscribeToEvents: async (taskId) => {
    const store = get();

    // 如果已经订阅，不重复订阅
    if (store.subscribedTaskIds.has(taskId)) {
      console.log('[Scheduler] 任务已订阅，跳过:', taskId);
      return;
    }

    // 将静默会话转换为可见会话（如果存在）
    const sessionId = `scheduler-${taskId}`
    const { sessionStoreManager } = await import('./conversationStore/sessionStoreManager')
    sessionStoreManager.getState().makeSessionVisible(sessionId)

    const router = getEventRouter();
    await router.initialize();

    const contextId = `scheduler-${taskId}`;

    // 清理旧的订阅
    const oldUnsubscribe = eventSubscriptions.get(taskId);
    if (oldUnsubscribe) {
      oldUnsubscribe();
    }

    // 注册新的处理器
    const unsubscribe = router.register(contextId, (payload: unknown) => {
      const event = payload as Record<string, unknown>;
      const log = parseEventToLog(event);

      if (log) {
        get().addLog(taskId, log);
      }

      // 关键修改：将事件也路由到会话 Store
      // 这确保会话标签页能正确更新状态
      const sessionId = `scheduler-${taskId}`
      const { sessionStoreManager } = require('./conversationStore/sessionStoreManager')
      sessionStoreManager.getState().dispatchEvent({
        ...event,
        _routeSessionId: sessionId,
      } as AIEvent & { _routeSessionId: string })

      // 处理会话结束
      if (event.type === 'session_end') {
        const reason = event.reason as string | undefined;
        if (reason === 'error' || reason === 'failed') {
          get().updateRunStatus(taskId, 'failed');
        } else {
          get().updateRunStatus(taskId, 'success');
        }

        // 清理订阅
        eventSubscriptions.delete(taskId);
        set((state) => {
          const newSubscribedTaskIds = new Set(state.subscribedTaskIds);
          newSubscribedTaskIds.delete(taskId);
          return { subscribedTaskIds: newSubscribedTaskIds };
        });
      } else if (event.type === 'error') {
        get().updateRunStatus(taskId, 'failed');
        eventSubscriptions.delete(taskId);
        set((state) => {
          const newSubscribedTaskIds = new Set(state.subscribedTaskIds);
          newSubscribedTaskIds.delete(taskId);
          return { subscribedTaskIds: newSubscribedTaskIds };
        });
      }
    });

    eventSubscriptions.set(taskId, unsubscribe);

    // 标记为已订阅
    set((state) => {
      const newSubscribedTaskIds = new Set(state.subscribedTaskIds);
      newSubscribedTaskIds.add(taskId);
      return { subscribedTaskIds: newSubscribedTaskIds };
    });

    // 如果是第一个执行的任务，自动打开抽屉
    const executions = get().executions;
    if (executions.size === 1) {
      set({ drawerOpen: true, activeTaskId: taskId });
    }
  },

  unsubscribeFromEvents: (taskId) => {
    const unsubscribe = eventSubscriptions.get(taskId);
    if (unsubscribe) {
      unsubscribe();
      eventSubscriptions.delete(taskId);
    }

    set((state) => {
      const newSubscribedTaskIds = new Set(state.subscribedTaskIds);
      newSubscribedTaskIds.delete(taskId);
      return { subscribedTaskIds: newSubscribedTaskIds };
    });
  },

  isTaskSubscribed: (id) => {
    return get().subscribedTaskIds.has(id);
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
    // 取消订阅
    get().unsubscribeFromEvents(taskId);

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

  // === 模板管理 ===

  loadTemplates: async () => {
    set({ templatesLoading: true });
    try {
      const templates = await tauri.schedulerListTemplates();
      set({ templates, templatesLoading: false });
    } catch (e) {
      const error = extractErrorMessage(e);
      console.error('加载模板失败:', error);
      set({ templatesLoading: false });
    }
  },

  createTemplate: async (params) => {
    try {
      const template = await tauri.schedulerCreateTemplate(params);
      const templates = await tauri.schedulerListTemplates();
      set({ templates });
      return template;
    } catch (e) {
      const error = extractErrorMessage(e);
      throw new Error(error || 'scheduler.errors.createTemplateFailed');
    }
  },

  updateTemplate: async (template) => {
    try {
      const updated = await tauri.schedulerUpdateTemplate(template);
      const templates = await tauri.schedulerListTemplates();
      set({ templates });
      return updated;
    } catch (e) {
      const error = extractErrorMessage(e);
      throw new Error(error || 'scheduler.errors.updateTemplateFailed');
    }
  },

  deleteTemplate: async (id) => {
    try {
      await tauri.schedulerDeleteTemplate(id);
      const templates = await tauri.schedulerListTemplates();
      set({ templates });
    } catch (e) {
      const error = extractErrorMessage(e);
      throw new Error(error || 'scheduler.errors.deleteTemplateFailed');
    }
  },

  toggleTemplate: async (id, enabled) => {
    try {
      await tauri.schedulerToggleTemplate(id, enabled);
      const templates = await tauri.schedulerListTemplates();
      set({ templates });
    } catch (e) {
      const error = extractErrorMessage(e);
      throw new Error(error);
    }
  },

  buildPrompt: async (templateId, taskName, userPrompt) => {
    return await tauri.schedulerBuildPrompt(templateId, taskName, userPrompt);
  },

  // === 协议模板管理 ===

  loadProtocolTemplates: async () => {
    set({ protocolTemplatesLoading: true });
    try {
      const protocolTemplates = await tauri.schedulerListProtocolTemplates();
      set({ protocolTemplates, protocolTemplatesLoading: false });
    } catch (e) {
      const error = extractErrorMessage(e);
      console.error('加载协议模板失败:', error);
      set({ protocolTemplatesLoading: false });
    }
  },

  loadProtocolTemplatesByCategory: async (category) => {
    set({ protocolTemplatesLoading: true });
    try {
      const protocolTemplates = await tauri.schedulerListProtocolTemplatesByCategory(category);
      set({ protocolTemplates, protocolTemplatesLoading: false });
    } catch (e) {
      const error = extractErrorMessage(e);
      console.error('加载协议模板失败:', error);
      set({ protocolTemplatesLoading: false });
    }
  },

  getProtocolTemplate: async (id) => {
    try {
      return await tauri.schedulerGetProtocolTemplate(id);
    } catch (e) {
      const error = extractErrorMessage(e);
      throw new Error(error);
    }
  },

  createProtocolTemplate: async (params) => {
    try {
      const template = await tauri.schedulerCreateProtocolTemplate(params);
      const protocolTemplates = await tauri.schedulerListProtocolTemplates();
      set({ protocolTemplates });
      return template;
    } catch (e) {
      const error = extractErrorMessage(e);
      throw new Error(error || 'scheduler.errors.createProtocolTemplateFailed');
    }
  },

  updateProtocolTemplate: async (id, params) => {
    try {
      const updated = await tauri.schedulerUpdateProtocolTemplate(id, params);
      const protocolTemplates = await tauri.schedulerListProtocolTemplates();
      set({ protocolTemplates });
      return updated;
    } catch (e) {
      const error = extractErrorMessage(e);
      throw new Error(error || 'scheduler.errors.updateProtocolTemplateFailed');
    }
  },

  deleteProtocolTemplate: async (id) => {
    try {
      const result = await tauri.schedulerDeleteProtocolTemplate(id);
      if (result) {
        const protocolTemplates = await tauri.schedulerListProtocolTemplates();
        set({ protocolTemplates });
      }
      return result;
    } catch (e) {
      const error = extractErrorMessage(e);
      throw new Error(error || 'scheduler.errors.deleteProtocolTemplateFailed');
    }
  },

  toggleProtocolTemplate: async (id, enabled) => {
    try {
      await tauri.schedulerToggleProtocolTemplate(id, enabled);
      const protocolTemplates = await tauri.schedulerListProtocolTemplates();
      set({ protocolTemplates });
    } catch (e) {
      const error = extractErrorMessage(e);
      throw new Error(error);
    }
  },

  renderProtocolDocument: async (template, params) => {
    return await tauri.schedulerRenderProtocolDocument(template, params);
  },
}));
