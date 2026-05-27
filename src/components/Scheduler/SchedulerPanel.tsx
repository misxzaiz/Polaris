/**
 * 定时任务管理面板
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke, listen } from '@/services/transport';
import { Clock, MoreVertical, Search, Plus, FileText, ScrollText, Activity } from 'lucide-react';
import { useSchedulerStore, useToastStore } from '@/stores';
import type { ScheduledTask, CreateTaskParams, TaskDueEvent, TriggerType } from '@/types/scheduler';
import { createLogger } from '@/utils/logger';
import { TaskCard } from './TaskCard';
import { TaskEditor } from './TaskEditor';
import { ExecutionLogDrawer } from './ExecutionLogDrawer';
import { TemplateManager } from './TemplateManager';
import { ProtocolTemplateManager } from './ProtocolTemplateManager';
import { ProtocolDocumentViewer } from './ProtocolDocumentViewer';
import { ConfirmDialog } from '../Common/ConfirmDialog';

const log = createLogger('SchedulerPanel');

/** 筛选条件 */
interface TaskFilter {
  search: string;
  status: 'all' | 'enabled' | 'disabled';
  engineId: string;
  triggerType: 'all' | TriggerType;
}

/** 排序条件 */
interface TaskSort {
  field: 'name' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'nextRunAt';
  order: 'asc' | 'desc';
}

const DEFAULT_FILTER: TaskFilter = {
  search: '',
  status: 'all',
  engineId: 'all',
  triggerType: 'all',
};

const DEFAULT_SORT: TaskSort = {
  field: 'createdAt',
  order: 'desc',
};

const FILTER_STORAGE_KEY = 'scheduler-filter';
const SORT_STORAGE_KEY = 'scheduler-sort';

/** 从 localStorage 加载筛选条件 */
function loadFilterFromStorage(): TaskFilter {
  try {
    const saved = localStorage.getItem(FILTER_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...DEFAULT_FILTER, ...parsed };
    }
  } catch (e) {
    log.warn('加载筛选条件失败', { error: e instanceof Error ? e.message : String(e) });
  }
  return DEFAULT_FILTER;
}

/** 保存筛选条件到 localStorage */
function saveFilterToStorage(filter: TaskFilter): void {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filter));
  } catch (e) {
    log.warn('保存筛选条件失败', { error: e instanceof Error ? e.message : String(e) });
  }
}

/** 从 localStorage 加载排序条件 */
function loadSortFromStorage(): TaskSort {
  try {
    const saved = localStorage.getItem(SORT_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...DEFAULT_SORT, ...parsed };
    }
  } catch (e) {
    log.warn('加载排序条件失败', { error: e instanceof Error ? e.message : String(e) });
  }
  return DEFAULT_SORT;
}

/** 保存排序条件到 localStorage */
function saveSortToStorage(sort: TaskSort): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
  } catch (e) {
    log.warn('保存排序条件失败', { error: e instanceof Error ? e.message : String(e) });
  }
}

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

/** 排序任务 */
function sortTasks(tasks: ScheduledTask[], sort: TaskSort): ScheduledTask[] {
  return [...tasks].sort((a, b) => {
    let aValue: string | number | undefined;
    let bValue: string | number | undefined;

    switch (sort.field) {
      case 'name':
        aValue = a.name.toLowerCase();
        bValue = b.name.toLowerCase();
        break;
      case 'createdAt':
        aValue = a.createdAt;
        bValue = b.createdAt;
        break;
      case 'updatedAt':
        aValue = a.updatedAt;
        bValue = b.updatedAt;
        break;
      case 'lastRunAt':
        aValue = a.lastRunAt || 0;
        bValue = b.lastRunAt || 0;
        break;
      case 'nextRunAt':
        aValue = a.nextRunAt || 0;
        bValue = b.nextRunAt || 0;
        break;
    }

    if (aValue === bValue) return 0;
    if (aValue === undefined || aValue === null) return 1;
    if (bValue === undefined || bValue === null) return -1;

    const comparison = aValue < bValue ? -1 : 1;
    return sort.order === 'asc' ? comparison : -comparison;
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
    updateRunStatus,
    isTaskRunning,
    isTaskSubscribed,
    subscribeToEvents,
    loadSchedulerStatus,
    handleTaskDue,
    buildPrompt,
    schedulerStatus,
    startScheduler,
    stopScheduler,
    statusLoading,
  } = useSchedulerStore();

  // 编辑器状态
  const [showEditor, setShowEditor] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | undefined>();
  const [copyingTask, setCopyingTask] = useState<ScheduledTask | undefined>();

  // 模板管理状态
  const [showTemplateManager, setShowTemplateManager] = useState(false);

  // 协议模板管理状态
  const [showProtocolTemplateManager, setShowProtocolTemplateManager] = useState(false);

  // 协议文档查看状态
  const [viewingProtocolTask, setViewingProtocolTask] = useState<ScheduledTask | null>(null);

  // 筛选状态（从 localStorage 恢复）
  const [filter, setFilter] = useState<TaskFilter>(loadFilterFromStorage);

  // 排序状态（从 localStorage 恢复）
  const [sort, setSort] = useState<TaskSort>(loadSortFromStorage);

  // 筛选栏展开状态
  const [filterExpanded, setFilterExpanded] = useState(false);

  // 更多菜单状态
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);

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

  // 筛选条件变化时保存到 localStorage
  useEffect(() => {
    saveFilterToStorage(filter);
  }, [filter]);

  // 排序条件变化时保存到 localStorage
  useEffect(() => {
    saveSortToStorage(sort);
  }, [sort]);

  // 监听任务到期事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;

    const setupListener = async () => {
      unlisten = await listen<TaskDueEvent>('scheduler-task-due', async (event) => {
        if (!mounted) return;

        try {
          toast.info(t('toast.taskDue'), t('toast.executing', { name: event.taskName }));
          await handleTaskDue(event);
        } catch (e) {
          log.error('任务执行失败', e instanceof Error ? e : new Error(String(e)));
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

      // 构建最终提示词
      let finalPrompt = task.prompt;

      // 调试日志
      log.info('手动执行任务:', {
        taskId: task.id,
        taskName: task.name,
        mode: task.mode,
        taskPath: task.taskPath,
        workDir: task.workDir,
        hasTemplateId: !!task.templateId,
        promptLength: task.prompt?.length ?? 0,
      });

      // 协议模式：从文档构建 prompt
      if (task.mode === 'protocol') {
        if (task.taskPath && task.workDir) {
          try {
            const { schedulerBuildProtocolPrompt } = await import('../../services/tauri');
            finalPrompt = await schedulerBuildProtocolPrompt(task.taskPath, task.workDir);
            log.debug('Protocol prompt built', { promptLength: finalPrompt?.length ?? 0 });
          } catch (e) {
            log.error('Failed to build protocol prompt', e instanceof Error ? e : new Error(String(e)));
            finalPrompt = task.mission || task.prompt || '';
          }
        } else {
          log.error('协议模式缺少 taskPath 或 workDir');
          finalPrompt = task.mission || task.prompt || '';
        }
      } else if (task.templateId) {
        // 简单模式 + 模板
        try {
          finalPrompt = await buildPrompt(task.templateId, task.name, task.prompt);
          log.debug('Template applied', { promptLength: finalPrompt?.length ?? 0 });
        } catch (e) {
          log.error('Failed to apply template', e instanceof Error ? e : new Error(String(e)));
        }
      }

      // 检查 prompt 是否为空
      if (!finalPrompt || finalPrompt.trim().length === 0) {
        log.error('提示词为空，无法执行任务');
        toast.error(t('toast.runFailed'), '提示词为空，无法执行任务');
        await updateRunStatus(task.id, 'failed');
        return;
      }

      // 调用 AI 引擎
      const engineId = task.engineId || 'claude-code';
      const sessionId = await invoke<string>('start_chat', {
        message: finalPrompt,
        options: {
          workDir: task.workDir,
          contextId: `scheduler-${task.id}`,
          engineId,
        },
      });

      log.info('Task execution session started', { sessionId });
      toast.success(t('toast.runTriggered'));
    } catch (e) {
      log.error('Task execution failed', e instanceof Error ? e : new Error(String(e)));
      toast.error(t('toast.runFailed'), e instanceof Error ? e.message : '');
    }
  };

  // 订阅日志（仅订阅正在执行的任务）
  const handleSubscribe = async (task: ScheduledTask) => {
    if (!isTaskRunning(task.id)) {
      toast.warning(t('toast.notRunning'));
      return;
    }

    if (isTaskSubscribed(task.id)) {
      return; // 已订阅，不重复订阅
    }

    try {
      await subscribeToEvents(task.id);
      toast.success(t('toast.subscribeSuccess'));
    } catch (e) {
      log.error('Failed to subscribe to logs', e instanceof Error ? e : new Error(String(e)));
      toast.error(t('toast.subscribeFailed'), e instanceof Error ? e.message : '');
    }
  };

  // 筛选后的任务
  const engineOptions = [...new Set(tasks.map((t) => t.engineId))].sort();
  const filteredTasks = sortTasks(filterTasks(tasks, filter), sort);

  // 排序字段选项
  const sortFieldOptions = [
    { value: 'createdAt', label: t('sort.createdAt', '创建时间') },
    { value: 'updatedAt', label: t('sort.updatedAt', '更新时间') },
    { value: 'name', label: t('sort.name', '任务名称') },
    { value: 'lastRunAt', label: t('sort.lastRunAt', '上次执行') },
    { value: 'nextRunAt', label: t('sort.nextRunAt', '下次执行') },
  ];

  return (
    <div className="h-full flex flex-col bg-background-base">
      {/* 紧凑头部 - h-10 (40px) */}
      <div className="h-10 px-3 border-b border-border-subtle flex items-center justify-between bg-background-surface shrink-0">
        {/* 左侧：标题 + 统计 */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Clock size={16} className="text-text-secondary shrink-0" />
          <h1 className="text-sm font-medium text-text-primary truncate">{t('title')}</h1>
          <span className="text-xs text-text-muted shrink-0">({tasks.length})</span>
          {/* 调度器状态指示器 */}
          {schedulerStatus?.isRunning && (
            <div className="flex items-center gap-1 px-2 py-0.5 bg-success-faint text-success text-xs rounded shrink-0">
              <Activity size={12} />
              <span className="hidden sm:inline">{t('control.running')}</span>
            </div>
          )}
        </div>

        {/* 右侧：操作按钮 */}
        <div className="flex items-center gap-1 shrink-0">
          {/* 更多菜单 */}
          <div className="relative">
            <button
              onClick={() => setMoreMenuOpen(!moreMenuOpen)}
              className="p-1.5 rounded hover:bg-background-hover text-text-secondary hover:text-text-primary transition-colors"
              title={t('more', '更多')}
            >
              <MoreVertical size={16} />
            </button>
            {moreMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMoreMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1 w-40 bg-background-surface border border-border-subtle rounded-lg shadow-lg z-50 py-1">
                  <button
                    onClick={() => { setShowTemplateManager(true); setMoreMenuOpen(false); }}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-background-hover flex items-center gap-2 text-text-secondary hover:text-text-primary"
                  >
                    <FileText size={14} />
                    {t('template.title')}
                  </button>
                  <button
                    onClick={() => { setShowProtocolTemplateManager(true); setMoreMenuOpen(false); }}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-background-hover flex items-center gap-2 text-text-secondary hover:text-text-primary"
                  >
                    <ScrollText size={14} />
                    {t('protocolTemplate.title')}
                  </button>
                  <div className="h-px bg-border-subtle my-1" />
                  {/* 调度器控制 - 内嵌 */}
                  <div className="px-3 py-2 flex items-center justify-between">
                    <span className="text-sm text-text-secondary">{t('control.scheduler', '调度器')}</span>
                    {schedulerStatus?.isRunning ? (
                      <button
                        onClick={async () => { await stopScheduler(); setMoreMenuOpen(false); }}
                        disabled={statusLoading}
                        className="px-2 py-0.5 text-xs bg-danger-faint text-danger hover:bg-danger/20 rounded transition-colors disabled:opacity-50"
                      >
                        {t('control.stop')}
                      </button>
                    ) : (
                      <button
                        onClick={async () => { await startScheduler(); setMoreMenuOpen(false); }}
                        disabled={statusLoading}
                        className="px-2 py-0.5 text-xs bg-success-faint text-success hover:bg-success/20 rounded transition-colors disabled:opacity-50"
                      >
                        {t('control.start')}
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* 搜索按钮 */}
          <button
            onClick={() => setFilterExpanded(!filterExpanded)}
            className={`p-1.5 rounded transition-colors ${filterExpanded ? 'bg-primary-faint text-primary' : 'hover:bg-background-hover text-text-secondary hover:text-text-primary'}`}
            title={t('filter.search')}
          >
            <Search size={16} />
          </button>

          {/* 新建按钮 */}
          <button
            onClick={() => { setEditingTask(undefined); setCopyingTask(undefined); setShowEditor(true); }}
            className="h-7 px-2.5 bg-primary hover:bg-primary-hover text-white rounded text-xs font-medium flex items-center gap-1 transition-colors"
          >
            <Plus size={14} />
            {t('newTask')}
          </button>
        </div>
      </div>

      {/* 可折叠筛选栏 */}
      {filterExpanded && (
        <div className="px-3 py-2 border-b border-border-subtle bg-background-base animate-in slide-in-from-top-2 duration-200">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              placeholder={t('filter.search')}
              value={filter.search}
              onChange={(e) => setFilter({ ...filter, search: e.target.value })}
              className="flex-1 min-w-0 max-w-48 px-2.5 py-1 text-xs bg-background-surface border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            <select
              value={filter.status}
              onChange={(e) => setFilter({ ...filter, status: e.target.value as TaskFilter['status'] })}
              className="px-2 py-1 text-xs bg-background-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              <option value="all">{t('filter.allStatus')}</option>
              <option value="enabled">{t('filter.enabled')}</option>
              <option value="disabled">{t('filter.disabled')}</option>
            </select>
            <select
              value={filter.triggerType}
              onChange={(e) => setFilter({ ...filter, triggerType: e.target.value as TaskFilter['triggerType'] })}
              className="px-2 py-1 text-xs bg-background-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              <option value="all">{t('filter.allTriggers')}</option>
              <option value="interval">{t('triggerTypes.interval')}</option>
              <option value="cron">{t('triggerTypes.cron')}</option>
              <option value="once">{t('triggerTypes.once')}</option>
            </select>
            <select
              value={filter.engineId}
              onChange={(e) => setFilter({ ...filter, engineId: e.target.value })}
              className="px-2 py-1 text-xs bg-background-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              <option value="all">{t('filter.allEngines')}</option>
              {engineOptions.map((engine) => (
                <option key={engine} value={engine}>{engine}</option>
              ))}
            </select>
            <button
              onClick={() => setFilter(DEFAULT_FILTER)}
              className="px-2 py-1 text-xs hover:bg-background-hover text-text-secondary hover:text-text-primary rounded transition-colors"
            >
              {t('filter.clear')}
            </button>
            {filteredTasks.length !== tasks.length && (
              <span className="text-xs text-text-muted">{filteredTasks.length}/{tasks.length}</span>
            )}
            {/* 排序 */}
            <div className="flex items-center gap-1 ml-auto pl-2 border-l border-border-subtle">
              <select
                value={sort.field}
                onChange={(e) => setSort({ ...sort, field: e.target.value as TaskSort['field'] })}
                className="px-2 py-1 text-xs bg-background-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
              >
                {sortFieldOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <button
                onClick={() => setSort({ ...sort, order: sort.order === 'asc' ? 'desc' : 'asc' })}
                className="p-1 text-xs bg-background-surface border border-border-subtle rounded text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
                title={sort.order === 'asc' ? t('sort.ascending', '升序') : t('sort.descending', '降序')}
              >
                {sort.order === 'asc' ? '↑' : '↓'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 任务列表 */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
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
                onViewProtocol={
                  task.mode === 'protocol' && task.taskPath
                    ? () => setViewingProtocolTask(task)
                    : undefined
                }
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

      {/* 模板管理弹窗 */}
      {showTemplateManager && <TemplateManager onClose={() => setShowTemplateManager(false)} />}

      {/* 协议模板管理弹窗 */}
      {showProtocolTemplateManager && (
        <ProtocolTemplateManager onClose={() => setShowProtocolTemplateManager(false)} />
      )}

      {/* 协议文档查看弹窗 */}
      {viewingProtocolTask && (
        <ProtocolDocumentViewer
          task={viewingProtocolTask}
          onClose={() => setViewingProtocolTask(null)}
        />
      )}
    </div>
  );
}

export default SchedulerPanel;
