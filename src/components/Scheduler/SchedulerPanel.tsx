/**
 * 定时任务管理面板
 */

import { useEffect, useState } from 'react';
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
    isTaskRunning,
    isTaskSubscribed,
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

  // 执行任务（不订阅日志）
  const handleRun = async (task: ScheduledTask) => {
    if (isTaskRunning(task.id)) {
      toast.warning(t('toast.pleaseWait'));
      return;
    }

    try {
      // 执行任务（不订阅）
      await runTask(task.id, { subscribe: false });

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
    }
  };

  // 订阅执行（执行并显示日志）
  const handleSubscribe = async (task: ScheduledTask) => {
    if (isTaskRunning(task.id)) {
      toast.warning(t('toast.pleaseWait'));
      return;
    }

    try {
      // 执行任务并订阅日志
      await runTask(task.id, { subscribe: true });

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

      console.log('[Scheduler] 订阅执行会话 ID:', sessionId);
      toast.success(t('toast.subscribeTriggered'));
    } catch (e) {
      console.error('[Scheduler] 订阅执行失败:', e);
      toast.error(t('toast.runFailed'), e instanceof Error ? e.message : '');
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
                isSubscribed={isTaskSubscribed(task.id)}
                onEdit={() => {
                  setCopyingTask(undefined);
                  setEditingTask(task);
                  setShowEditor(true);
                }}
                onCopy={() => handleCopy(task)}
                onDelete={() => handleDelete(task.id)}
                onToggle={() => toggleTask(task.id, !task.enabled)}
                onRun={() => handleRun(task)}
                onSubscribe={() => handleSubscribe(task)}
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
