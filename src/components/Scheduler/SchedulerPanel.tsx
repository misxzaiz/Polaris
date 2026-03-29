/**
 * 定时任务管理面板
 */

import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useSchedulerStore, useToastStore } from '../../stores';
import type { ScheduledTask, CreateTaskParams, TaskDueEvent, TriggerType } from '../../types/scheduler';
import { SchedulerControl } from './SchedulerControl';
import { TaskCard } from './TaskCard';
import { TaskEditor } from './TaskEditor';
import { ExecutionLogDrawer } from './ExecutionLogDrawer';
import { ConfirmDialog } from '../Common/ConfirmDialog';
import { getEventRouter } from '../../services/eventRouter';

/** 筛选条件 */
interface TaskFilter {
  search: string;
  status: 'all' | 'enabled' | 'disabled';
  engineId: string;
  triggerType: 'all' | TriggerType;
}

const DEFAULT_FILTER: TaskFilter = {
  search: '',
  status: 'all',
  engineId: 'all',
  triggerType: 'all',
};

/** 筛选任务 */
function filterTasks(tasks: ScheduledTask[], filter: TaskFilter): ScheduledTask[] {
  return tasks.filter((task) => {
    if (filter.search && !task.name.toLowerCase().includes(filter.search.toLowerCase())) {
      return false;
    }
    if (filter.status === 'enabled' && !task.enabled) return false;
    if (filter.status === 'disabled' && task.enabled) return false;
    if (filter.engineId !== 'all' && task.engineId !== filter.engineId) return false;
    if (filter.triggerType !== 'all' && task.triggerType !== filter.triggerType) return false;
    return true;
  });
}

/** 解析 AI 事件为日志 */
function parseEventToLog(event: Record<string, unknown>): {
  type: 'session_start' | 'message' | 'thinking' | 'tool_call_start' | 'tool_call_end' | 'error' | 'session_end';
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

export function SchedulerPanel() {
  const { t } = useTranslation('scheduler');
  const toast = useToastStore();

  const {
    tasks,
    loading,
    loadTasks,
    createTask,
    updateTask,
    deleteTask,
    toggleTask,
    runTask,
    updateRunStatus,
    addLog,
    isTaskRunning,
    loadSchedulerStatus,
    handleTaskDue,
  } = useSchedulerStore();

  // 编辑器状态
  const [showEditor, setShowEditor] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | undefined>();
  const [copyingTask, setCopyingTask] = useState<ScheduledTask | undefined>();

  // 筛选状态
  const [filter, setFilter] = useState<TaskFilter>(DEFAULT_FILTER);

  // 确认对话框
  const [confirmDialog, setConfirmDialog] = useState<{
    show: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  // 事件订阅清理函数
  const unsubscribesRef = useRef<Map<string, () => void>>(new Map());

  // 加载任务和调度器状态
  useEffect(() => {
    loadTasks();
    loadSchedulerStatus();
  }, [loadTasks, loadSchedulerStatus]);

  // 定时刷新调度器状态
  useEffect(() => {
    const interval = setInterval(loadSchedulerStatus, 5000);
    return () => clearInterval(interval);
  }, [loadSchedulerStatus]);

  // 监听任务到期事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;

    const setupListener = async () => {
      unlisten = await listen<TaskDueEvent>('scheduler-task-due', async (event) => {
        if (!mounted) return;

        try {
          toast.info(t('toast.taskDue'), t('toast.executing', { name: event.payload.taskName }));
          await handleTaskDue(event.payload);
        } catch (e) {
          console.error('[Scheduler] 任务执行失败:', e);
          toast.error(t('toast.executeFailed'), e instanceof Error ? e.message : String(e));
        }
      });
    };

    setupListener();

    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [handleTaskDue, toast, t]);

  // 注册事件处理器
  const registerEventHandler = async (taskId: string) => {
    const router = getEventRouter();
    await router.initialize();

    const contextId = `scheduler-${taskId}`;

    // 清理旧的订阅
    const oldUnsubscribe = unsubscribesRef.current.get(taskId);
    if (oldUnsubscribe) {
      oldUnsubscribe();
    }

    // 注册新的处理器
    const unsubscribe = router.register(contextId, (payload: unknown) => {
      const event = payload as Record<string, unknown>;
      const log = parseEventToLog(event);

      if (log) {
        addLog(taskId, log);
      }

      // 处理会话结束
      if (event.type === 'session_end') {
        const reason = event.reason as string | undefined;
        if (reason === 'error' || reason === 'failed') {
          updateRunStatus(taskId, 'failed');
        } else {
          updateRunStatus(taskId, 'success');
        }

        // 清理订阅
        unsubscribesRef.current.delete(taskId);
      } else if (event.type === 'error') {
        updateRunStatus(taskId, 'failed');
        unsubscribesRef.current.delete(taskId);
      }
    });

    unsubscribesRef.current.set(taskId, unsubscribe);
  };

  // 清理所有订阅
  useEffect(() => {
    return () => {
      unsubscribesRef.current.forEach((unsubscribe) => unsubscribe());
      unsubscribesRef.current.clear();
    };
  }, []);

  // 创建任务
  const handleCreate = async (params: CreateTaskParams) => {
    try {
      await createTask(params);
      toast.success(t('toast.createSuccess'));
      setShowEditor(false);
    } catch (e) {
      toast.error(t('toast.createFailed'), e instanceof Error ? e.message : '');
    }
  };

  // 复制任务
  const handleCopy = (task: ScheduledTask) => {
    setEditingTask(undefined);
    setCopyingTask({
      ...task,
      name: `${task.name}（${t('editor.copySuffix')}）`,
    });
    setShowEditor(true);
  };

  // 复制保存
  const handleCopySave = async (params: CreateTaskParams) => {
    try {
      await createTask(params);
      toast.success(t('toast.copySuccess'));
      setShowEditor(false);
      setCopyingTask(undefined);
    } catch (e) {
      toast.error(t('toast.copyFailed'), e instanceof Error ? e.message : '');
    }
  };

  // 更新任务
  const handleUpdate = async (params: CreateTaskParams) => {
    if (!editingTask) return;
    try {
      await updateTask({
        ...editingTask,
        ...params,
      });
      toast.success(t('toast.updateSuccess'));
      setShowEditor(false);
      setEditingTask(undefined);
    } catch (e) {
      toast.error(t('toast.updateFailed'), e instanceof Error ? e.message : '');
    }
  };

  // 删除任务
  const handleDelete = (id: string) => {
    setConfirmDialog({
      show: true,
      title: t('confirm.deleteTitle'),
      message: t('confirm.deleteMessage'),
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await deleteTask(id);
          toast.success(t('toast.deleteSuccess'));
        } catch (e) {
          toast.error(t('toast.deleteFailed'), e instanceof Error ? e.message : '');
        }
      },
    });
  };

  // 执行任务
  const handleRun = async (task: ScheduledTask) => {
    if (isTaskRunning(task.id)) {
      toast.warning(t('toast.pleaseWait'));
      return;
    }

    try {
      // 初始化执行状态
      await runTask(task.id);

      // 注册事件处理器
      await registerEventHandler(task.id);

      // 调用 AI 引擎
      const engineId = task.engineId || 'claude-code';
      const sessionId = await invoke<string>('start_chat', {
        message: task.prompt,
        options: {
          workDir: task.workDir,
          contextId: `scheduler-${task.id}`,
          engineId,
          enableMcpTools: engineId === 'claude-code',
        },
      });

      console.log('[Scheduler] 任务执行会话 ID:', sessionId);
      toast.success(t('toast.runTriggered'));
    } catch (e) {
      console.error('[Scheduler] 任务执行失败:', e);
      toast.error(t('toast.runFailed'), e instanceof Error ? e.message : '');
      await updateRunStatus(task.id, 'failed');
    }
  };

  // 筛选后的任务
  const engineOptions = [...new Set(tasks.map((t) => t.engineId))].sort();
  const filteredTasks = filterTasks(tasks, filter);

  return (
    <div className="h-full flex flex-col bg-background-base">
      {/* 头部 */}
      <div className="px-4 py-4 border-b border-border-subtle flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-text-primary">{t('title')}</h1>
          <span className="text-xs text-text-muted bg-background-hover px-2 py-1 rounded">
            {t('taskCount', { count: tasks.length })}
          </span>
        </div>
        <button
          onClick={() => {
            setEditingTask(undefined);
            setCopyingTask(undefined);
            setShowEditor(true);
          }}
          className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors text-sm"
        >
          + {t('newTask')}
        </button>
      </div>

      {/* 调度器控制栏 */}
      <SchedulerControl />

      {/* 筛选栏 */}
      <div className="px-4 py-3 border-b border-border-subtle bg-background-surface">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder={t('filter.search')}
            value={filter.search}
            onChange={(e) => setFilter({ ...filter, search: e.target.value })}
            className="w-48 px-3 py-1.5 text-sm bg-background-base border border-border-subtle rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <select
            value={filter.status}
            onChange={(e) => setFilter({ ...filter, status: e.target.value as TaskFilter['status'] })}
            className="px-2 py-1.5 text-sm bg-background-base border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="all">{t('filter.allStatus')}</option>
            <option value="enabled">{t('filter.enabled')}</option>
            <option value="disabled">{t('filter.disabled')}</option>
          </select>
          <select
            value={filter.triggerType}
            onChange={(e) => setFilter({ ...filter, triggerType: e.target.value as TaskFilter['triggerType'] })}
            className="px-2 py-1.5 text-sm bg-background-base border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="all">{t('filter.allTriggers')}</option>
            <option value="interval">{t('triggerTypes.interval')}</option>
            <option value="cron">{t('triggerTypes.cron')}</option>
            <option value="once">{t('triggerTypes.once')}</option>
          </select>
          <select
            value={filter.engineId}
            onChange={(e) => setFilter({ ...filter, engineId: e.target.value })}
            className="px-2 py-1.5 text-sm bg-background-base border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="all">{t('filter.allEngines')}</option>
            {engineOptions.map((engine) => (
              <option key={engine} value={engine}>
                {engine}
              </option>
            ))}
          </select>
          <button
            onClick={() => setFilter(DEFAULT_FILTER)}
            className="px-3 py-1.5 text-sm bg-background-hover text-text-secondary hover:bg-background-active rounded-lg transition-colors"
          >
            {t('filter.clear')}
          </button>
          {filteredTasks.length !== tasks.length && (
            <span className="text-xs text-text-muted">
              {filteredTasks.length}/{tasks.length}
            </span>
          )}
        </div>
      </div>

      {/* 任务列表 */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="text-center text-text-muted py-8">{t('loading')}</div>
        ) : tasks.length === 0 ? (
          <div className="text-center text-text-muted py-8">{t('empty')}</div>
        ) : filteredTasks.length === 0 ? (
          <div className="text-center text-text-muted py-8">{t('noMatch')}</div>
        ) : (
          <div className="space-y-3">
            {filteredTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                isRunning={isTaskRunning(task.id)}
                onEdit={() => {
                  setCopyingTask(undefined);
                  setEditingTask(task);
                  setShowEditor(true);
                }}
                onCopy={() => handleCopy(task)}
                onDelete={() => handleDelete(task.id)}
                onToggle={() => toggleTask(task.id, !task.enabled)}
                onRun={() => handleRun(task)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 执行日志抽屉 */}
      <ExecutionLogDrawer />

      {/* 编辑弹窗 */}
      {showEditor && (
        <TaskEditor
          task={editingTask || copyingTask}
          onSave={editingTask ? handleUpdate : copyingTask ? handleCopySave : handleCreate}
          title={
            editingTask
              ? t('editor.editTask')
              : copyingTask
                ? t('editor.copyTask')
                : t('editor.newTask')
          }
          onClose={() => {
            setShowEditor(false);
            setEditingTask(undefined);
            setCopyingTask(undefined);
          }}
        />
      )}

      {/* 确认对话框 */}
      {confirmDialog?.show && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          type="danger"
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  );
}

export default SchedulerPanel;
