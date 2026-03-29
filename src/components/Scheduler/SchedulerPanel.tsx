/**
 * 定时任务管理面板（精简版）
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSchedulerStore, useToastStore } from '../../stores';
import { ConfirmDialog } from '../Common/ConfirmDialog';
import { DropdownMenu } from '../Common/DropdownMenu';
import type { DropdownMenuItem } from '../Common/DropdownMenu';
import type { ScheduledTask } from '../../types/scheduler';
import { TriggerTypeLabels } from '../../types/scheduler';
import type { CreateTaskParams } from '../../types/scheduler';
import { TaskEditor } from './TaskEditor';
import { useContainerSize } from '../../hooks';

/** 格式化相对时间 */
function formatRelativeTime(timestamp: number | undefined, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (!timestamp) return '--';
  const now = Date.now() / 1000;
  const diff = timestamp - now;

  if (diff < 0) return t('time.expired');
  if (diff < 60) return t('time.secondsLater', { count: Math.floor(diff) });
  if (diff < 3600) return t('time.minutesLater', { count: Math.floor(diff / 60) });
  if (diff < 86400) return t('time.hoursLater', { count: Math.floor(diff / 3600) });
  return t('time.daysLater', { count: Math.floor(diff / 86400) });
}

/** 状态徽章 */
function StatusBadge({ status }: { status?: 'running' | 'success' | 'failed' }) {
  const { t } = useTranslation('scheduler');
  if (!status) return <span className="text-text-muted">{t('status.notExecuted')}</span>;

  const styles = {
    running: 'bg-info-faint text-info',
    success: 'bg-success-faint text-success',
    failed: 'bg-danger-faint text-danger',
  };

  const labels = {
    running: t('status.running'),
    success: t('status.success'),
    failed: t('status.failed'),
  };

  return (
    <span className={`px-2 py-0.5 rounded text-xs ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

/** 任务卡片 */
function TaskCard({
  task,
  onEdit,
  onCopy,
  onDelete,
  onToggle,
  onRun,
  isRunning,
  isCompact,
}: {
  task: ScheduledTask;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onRun: () => void;
  isRunning?: boolean;
  isCompact?: boolean;
}) {
  const { t } = useTranslation('scheduler');

  const menuItems: DropdownMenuItem[] = [
    { key: 'run', label: t('task.run'), onClick: onRun },
    { key: 'toggle', label: task.enabled ? t('task.disabled') : t('task.enabled'), onClick: onToggle },
    { key: 'edit', label: t('task.edit'), onClick: onEdit },
    { key: 'copy', label: t('task.copy'), onClick: onCopy },
    { key: 'delete', label: t('task.delete'), variant: 'danger', onClick: onDelete },
  ];

  // 紧凑模式
  if (isCompact) {
    return (
      <div className={`bg-background-surface rounded-lg p-3 border border-border-subtle ${!task.enabled ? 'opacity-70' : ''}`}>
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${task.enabled ? 'bg-success' : 'bg-text-muted'}`} />
            <h3 className="text-text-primary text-sm font-medium truncate">{task.name}</h3>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <DropdownMenu
              trigger={
                <button className="w-7 h-7 flex items-center justify-center bg-background-hover text-text-secondary hover:bg-background-active rounded transition-colors text-xs">
                  ⋯
                </button>
              }
              items={menuItems}
              align="right"
            />
          </div>
        </div>
        <div className="text-xs text-text-muted flex items-center gap-2">
          <StatusBadge status={task.lastRunStatus} />
          {task.enabled && task.nextRunAt && (
            <span>
              {t('task.nextRun')}: <span className="text-primary">{formatRelativeTime(task.nextRunAt, t)}</span>
            </span>
          )}
        </div>
      </div>
    );
  }

  // 正常模式
  return (
    <div className={`bg-background-surface rounded-lg p-4 border border-border-subtle ${!task.enabled ? 'opacity-70' : ''}`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <span className={`w-2 h-2 rounded-full shrink-0 ${task.enabled ? 'bg-success' : 'bg-text-muted'}`} />
        <h3 className="text-text-primary font-medium truncate">{task.name}</h3>
        {task.description && (
          <span className="text-xs text-text-muted truncate">{task.description}</span>
        )}
      </div>

      {/* Body */}
      <div className="mb-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <span className="text-text-muted">{t('task.trigger')}</span>
          <span className="text-text-secondary">{TriggerTypeLabels[task.triggerType]} - {task.triggerValue}</span>
          <span className="text-text-muted">{t('task.engine')}</span>
          <span className="text-text-secondary">{task.engineId}</span>
          {task.enabled && task.nextRunAt && (
            <>
              <span className="text-text-muted">{t('task.nextRun')}</span>
              <span className="text-primary">{formatRelativeTime(task.nextRunAt, t)}</span>
            </>
          )}
          <span className="text-text-muted">{t('log.stats', { defaultValue: '状态' })}</span>
          <span><StatusBadge status={task.lastRunStatus} /></span>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 pt-3 border-t border-border-subtle flex-wrap">
        <button
          onClick={onRun}
          disabled={isRunning}
          className={`px-3 py-1 text-sm rounded transition-colors ${
            isRunning
              ? 'bg-info-faint text-info cursor-wait'
              : 'bg-primary-faint text-primary hover:bg-primary/30'
          }`}
        >
          {isRunning ? t('task.running') : t('task.run')}
        </button>
        <button
          onClick={onToggle}
          className={`px-3 py-1 text-sm rounded transition-colors ${
            task.enabled
              ? 'bg-warning-faint text-warning hover:bg-warning/30'
              : 'bg-success-faint text-success hover:bg-success/30'
          }`}
        >
          {task.enabled ? t('task.disabled') : t('task.enabled')}
        </button>
        <button
          onClick={onEdit}
          className="px-3 py-1 text-sm bg-background-hover text-text-secondary hover:bg-background-active rounded transition-colors"
        >
          {t('task.edit')}
        </button>
        <button
          onClick={onCopy}
          className="px-3 py-1 text-sm bg-info-faint text-info hover:bg-info/30 rounded transition-colors"
        >
          {t('task.copy')}
        </button>
        <button
          onClick={onDelete}
          className="px-3 py-1 text-sm bg-danger-faint text-danger hover:bg-danger/30 rounded transition-colors"
        >
          {t('task.delete')}
        </button>
      </div>
    </div>
  );
}

/** 任务筛选状态 */
interface TaskFilter {
  search: string;
  enabled: 'all' | 'enabled' | 'disabled';
  engineId: string;
  triggerType: 'all' | 'once' | 'cron' | 'interval';
}

const defaultFilter: TaskFilter = {
  search: '',
  enabled: 'all',
  engineId: 'all',
  triggerType: 'all',
};

/** 筛选任务 */
function filterTasks(tasks: ScheduledTask[], filter: TaskFilter): ScheduledTask[] {
  return tasks.filter((task) => {
    if (filter.search && !task.name.toLowerCase().includes(filter.search.toLowerCase())) {
      return false;
    }
    if (filter.enabled === 'enabled' && !task.enabled) return false;
    if (filter.enabled === 'disabled' && task.enabled) return false;
    if (filter.engineId !== 'all' && task.engineId !== filter.engineId) return false;
    if (filter.triggerType !== 'all' && task.triggerType !== filter.triggerType) return false;
    return true;
  });
}

/** 主面板 */
export function SchedulerPanel() {
  const { t } = useTranslation('scheduler');
  const { tasks, loading, loadTasks, createTask, updateTask, deleteTask, toggleTask, runTask, isTaskRunning, lockStatus, lockLoading, loadLockStatus, acquireLock, releaseLock } = useSchedulerStore();
  const toast = useToastStore();

  // 响应式布局检测
  const [containerRef, containerSize] = useContainerSize({ compactThreshold: 500 });
  const isCompact = containerSize.isCompact;

  const [showEditor, setShowEditor] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | undefined>();
  const [copyingTask, setCopyingTask] = useState<ScheduledTask | undefined>();
  const [filter, setFilter] = useState<TaskFilter>(defaultFilter);
  const [confirmDialog, setConfirmDialog] = useState<{
    show: boolean;
    title?: string;
    message: string;
    type?: 'danger' | 'warning' | 'info';
    onConfirm: () => void;
  } | null>(null);

  const engineOptions = [...new Set(tasks.map((t) => t.engineId))].sort();
  const filteredTasks = filterTasks(tasks, filter);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // 加载锁状态
  useEffect(() => {
    loadLockStatus();
    // 每 5 秒刷新锁状态
    const interval = setInterval(loadLockStatus, 5000);
    return () => clearInterval(interval);
  }, [loadLockStatus]);

  const handleCreate = async (params: CreateTaskParams) => {
    try {
      await createTask(params);
      toast.success(t('toast.createSuccess'));
      setShowEditor(false);
    } catch (e) {
      toast.error(t('toast.createFailed'), e instanceof Error ? e.message : t('toast.importFailedDetail'));
    }
  };

  const handleCopy = (task: ScheduledTask) => {
    setEditingTask(undefined);
    setCopyingTask({
      ...task,
      name: `${task.name}（副本）`,
    });
    setShowEditor(true);
  };

  const handleCopySave = async (params: CreateTaskParams) => {
    try {
      await createTask(params);
      toast.success(t('toast.copySuccess'));
      setShowEditor(false);
      setCopyingTask(undefined);
    } catch (e) {
      toast.error(t('toast.copyFailed'), e instanceof Error ? e.message : t('toast.importFailedDetail'));
    }
  };

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
      toast.error(t('toast.updateFailed'), e instanceof Error ? e.message : t('toast.importFailedDetail'));
    }
  };

  const handleDelete = async (id: string) => {
    setConfirmDialog({
      show: true,
      title: t('confirm.deleteTitle'),
      message: t('confirm.deleteMessage'),
      type: 'danger',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await deleteTask(id);
          toast.success(t('toast.deleteSuccess'));
        } catch (e) {
          toast.error(t('toast.deleteFailed'), e instanceof Error ? e.message : t('toast.importFailedDetail'));
        }
      },
    });
  };

  const handleRun = async (task: ScheduledTask) => {
    if (isTaskRunning(task.id)) {
      toast.warning(t('toast.pleaseWait'), t('toast.pleaseWaitDetail'));
      return;
    }

    try {
      await runTask(task.id);
      toast.success(t('toast.runTriggered'), t('toast.runTriggeredDetail', { name: task.name }));

      // TODO: 这里可以触发实际的 AI 引擎执行
      // 目前只是标记任务为执行中状态，实际执行需要调度器或用户手动触发

      // 模拟执行完成（实际应该由 AI 引擎执行后更新）
      // await updateRunStatus(task.id, 'success');
    } catch (e) {
      toast.error(t('toast.runTriggerFailed'), e instanceof Error ? e.message : t('toast.importFailedDetail'));
    }
  };

  return (
    <div ref={containerRef} className="h-full flex flex-col bg-background-base">
      {/* 头部 */}
      <div className="p-4 border-b border-border-subtle flex items-center justify-between">
        <h1 className="text-xl font-medium text-text-primary">{t('title')}</h1>
        <div className="flex items-center gap-3">
          {/* 锁状态显示和操作 */}
          <div className="flex items-center gap-2">
            {lockStatus?.isHolder ? (
              <>
                <span className="flex items-center gap-1.5 px-2 py-1 bg-success-faint text-success rounded-lg text-sm">
                  <span className="text-base">🔒</span>
                  <span>{t('lock.holder', { defaultValue: '持有锁' })}</span>
                </span>
                <button
                  onClick={async () => {
                    await releaseLock();
                    toast.success(t('lock.releaseSuccess', { defaultValue: '已释放锁' }));
                  }}
                  disabled={lockLoading}
                  className="px-3 py-1.5 text-sm bg-warning-faint text-warning hover:bg-warning/30 rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('lock.release', { defaultValue: '释放锁' })}
                </button>
              </>
            ) : lockStatus?.isLockedByOther ? (
              <>
                <span className="flex items-center gap-1.5 px-2 py-1 bg-danger-faint text-danger rounded-lg text-sm">
                  <span className="text-base">🔓</span>
                  <span>{t('lock.lockedByOther', { defaultValue: '其他实例持有锁' })}</span>
                </span>
                <button
                  onClick={async () => {
                    const success = await acquireLock();
                    if (success) {
                      toast.success(t('lock.acquireSuccess', { defaultValue: '已获取锁' }));
                    } else {
                      toast.warning(t('lock.acquireFailed', { defaultValue: '无法获取锁，其他实例仍在运行' }));
                    }
                  }}
                  disabled={lockLoading}
                  className="px-3 py-1.5 text-sm bg-primary-faint text-primary hover:bg-primary/30 rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('lock.acquire', { defaultValue: '获取锁' })}
                </button>
              </>
            ) : (
              <>
                <span className="flex items-center gap-1.5 px-2 py-1 bg-background-hover text-text-secondary rounded-lg text-sm">
                  <span className="text-base">🔓</span>
                  <span>{t('lock.noLock', { defaultValue: '无锁' })}</span>
                </span>
                <button
                  onClick={async () => {
                    const success = await acquireLock();
                    if (success) {
                      toast.success(t('lock.acquireSuccess', { defaultValue: '已获取锁' }));
                    }
                  }}
                  disabled={lockLoading}
                  className="px-3 py-1.5 text-sm bg-success-faint text-success hover:bg-success/30 rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('lock.acquire', { defaultValue: '获取锁' })}
                </button>
              </>
            )}
          </div>
          {/* 新建任务按钮 */}
          <button
            onClick={() => {
              setEditingTask(undefined);
              setCopyingTask(undefined);
              setShowEditor(true);
            }}
            className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors"
          >
            + {t('newTask')}
          </button>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="p-3 border-b border-border-subtle bg-background-surface">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder={t('filter.search')}
            value={filter.search}
            onChange={(e) => setFilter({ ...filter, search: e.target.value })}
            className={`px-3 py-1.5 text-sm bg-background-base border border-border-subtle rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 ${isCompact ? 'w-24' : 'w-48'}`}
          />
          <select
            value={filter.enabled}
            onChange={(e) => setFilter({ ...filter, enabled: e.target.value as TaskFilter['enabled'] })}
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
            <option value="once">{t('triggerTypes.once')}</option>
            <option value="cron">{t('triggerTypes.cron')}</option>
            <option value="interval">{t('triggerTypes.interval')}</option>
          </select>
          <select
            value={filter.engineId}
            onChange={(e) => setFilter({ ...filter, engineId: e.target.value })}
            className="px-2 py-1.5 text-sm bg-background-base border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="all">{t('filter.allEngines')}</option>
            {engineOptions.map((engine) => (
              <option key={engine} value={engine}>{engine}</option>
            ))}
          </select>
          <button
            onClick={() => setFilter(defaultFilter)}
            className="px-3 py-1.5 text-sm bg-background-hover text-text-secondary hover:bg-background-active rounded-lg transition-colors"
          >
            {t('filter.clearFilter')}
          </button>
          {filteredTasks.length !== tasks.length && (
            <span className="text-xs text-text-muted">
              {filteredTasks.length}/{tasks.length}
            </span>
          )}
        </div>
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="text-center text-text-muted py-8">{t('loading')}</div>
        ) : tasks.length === 0 ? (
          <div className="text-center text-text-muted py-8">{t('empty.noTasks')}</div>
        ) : (
          <div className="space-y-2">
            {filteredTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                isCompact={isCompact}
                onEdit={() => {
                  setCopyingTask(undefined);
                  setEditingTask(task);
                  setShowEditor(true);
                }}
                onCopy={() => handleCopy(task)}
                onDelete={() => handleDelete(task.id)}
                onToggle={() => toggleTask(task.id, !task.enabled)}
                onRun={() => handleRun(task)}
                isRunning={isTaskRunning(task.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 编辑弹窗 */}
      {showEditor && (
        <TaskEditor
          task={editingTask || copyingTask}
          onSave={editingTask ? handleUpdate : (copyingTask ? handleCopySave : handleCreate)}
          title={editingTask ? t('editor.editTask') : (copyingTask ? t('editor.copyTask') : t('editor.newTask'))}
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
          type={confirmDialog.type}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  );
}

export default SchedulerPanel;
