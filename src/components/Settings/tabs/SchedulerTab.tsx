/**
 * 定时任务设置 Tab
 */

import { useEffect, useState } from 'react';
import { useSchedulerStore, useToastStore } from '../../../stores';
import { schedulerGetLockStatus, schedulerStart, schedulerStop } from '../../../services/tauri';
import { ConfirmDialog } from '../../Common/ConfirmDialog';
import { TaskEditor } from '../../Scheduler/TaskEditor';
import { ProtocolTemplateManager } from '../../Scheduler/ProtocolTemplateManager';
import type { ScheduledTask, CreateTaskParams, LockStatus } from '../../../types/scheduler';
import { TriggerTypeLabels } from '../../../types/scheduler';
import { createLogger } from '../../../utils/logger';

const log = createLogger('SchedulerTab');

/** 格式化时间戳 */
function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return '--';
  return new Date(timestamp * 1000).toLocaleString('zh-CN');
}

/** 格式化相对时间 */
function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return '--';
  const now = Date.now() / 1000;
  const diff = timestamp - now;

  if (diff < 0) return '已过期';
  if (diff < 60) return `${Math.floor(diff)} 秒后`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟后`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时后`;
  return `${Math.floor(diff / 86400)} 天后`;
}

/** 状态徽章 */
function StatusBadge({ status }: { status?: 'running' | 'success' | 'failed' }) {
  if (!status) return <span className="text-gray-400">未执行</span>;

  const styles = {
    running: 'bg-blue-500/20 text-blue-400',
    success: 'bg-green-500/20 text-green-400',
    failed: 'bg-red-500/20 text-red-400',
  };

  const labels = {
    running: '执行中',
    success: '成功',
    failed: '失败',
  };

  return (
    <span className={`px-2 py-0.5 rounded text-xs ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

/** 可折叠的内容块 */
function CollapsibleContent({
  label,
  content,
  maxHeight = 100,
  className = 'text-text-secondary',
}: {
  label: string;
  content: string;
  maxHeight?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsExpand = content.length > 200 || content.split('\n').length > 5;

  return (
    <div className="mt-3">
      <div
        className="flex items-center justify-between text-sm text-text-muted mb-1 cursor-pointer hover:text-text-secondary"
        onClick={() => needsExpand && setExpanded(!expanded)}
      >
        <span>{label}:</span>
        {needsExpand && (
          <span className="text-xs text-primary">
            {expanded ? '收起' : '展开全部'}
          </span>
        )}
      </div>
      <pre
        className={`text-xs ${className} bg-background p-2 rounded overflow-x-auto whitespace-pre-wrap transition-all`}
        style={!expanded && needsExpand ? { maxHeight: `${maxHeight}px`, overflow: 'hidden' } : {}}
      >
        {content}
      </pre>
    </div>
  );
}

/** 主组件 */
export function SchedulerTab() {
  const { tasks, logs, loading, loadTasks, loadLogs, createTask, updateTask, deleteTask, toggleTask, runTask } =
    useSchedulerStore();
  const toast = useToastStore();

  const [showEditor, setShowEditor] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | undefined>();
  const [activeView, setActiveView] = useState<'tasks' | 'logs'>('tasks');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [lockStatus, setLockStatus] = useState<LockStatus | null>(null);
  const [operating, setOperating] = useState(false);
  const [showTemplateManager, setShowTemplateManager] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    show: boolean;
    title?: string;
    message: string;
    onConfirm: () => void;
    type?: 'danger' | 'warning' | 'info';
  } | null>(null);

  useEffect(() => {
    loadTasks();
    loadLogs(50);
    loadLockStatus();
  }, [loadTasks, loadLogs]);

  const loadLockStatus = async () => {
    try {
      const status = await schedulerGetLockStatus();
      setLockStatus(status);
    } catch (e) {
      log.error('获取锁状态失败', e instanceof Error ? e : new Error(String(e)));
    }
  };

  const handleStartScheduler = async () => {
    setOperating(true);
    try {
      const result = await schedulerStart();
      toast.success(result);
      await loadLockStatus();
    } catch (e) {
      toast.error('启动失败', e instanceof Error ? e.message : undefined);
    } finally {
      setOperating(false);
    }
  };

  const handleStopScheduler = () => {
    setConfirmDialog({
      show: true,
      title: '停止调度器',
      message: '确定要停止调度器吗？\n定时任务将不再自动执行。',
      type: 'warning',
      onConfirm: async () => {
        setConfirmDialog(null);
        setOperating(true);
        try {
          const result = await schedulerStop();
          toast.success(result);
          await loadLockStatus();
        } catch (e) {
          toast.error('停止失败', e instanceof Error ? e.message : undefined);
        } finally {
          setOperating(false);
        }
      },
    });
  };

  const handleCreate = async (params: CreateTaskParams) => {
    try {
      await createTask(params);
      toast.success('任务创建成功');
      setShowEditor(false);
    } catch (e) {
      toast.error('创建失败', e instanceof Error ? e.message : undefined);
    }
  };

  const handleUpdate = async (params: CreateTaskParams) => {
    if (!editingTask) return;
    try {
      await updateTask({
        ...editingTask,
        ...params,
      });
      toast.success('任务更新成功');
      setShowEditor(false);
      setEditingTask(undefined);
    } catch (e) {
      toast.error('更新失败', e instanceof Error ? e.message : undefined);
    }
  };

  const handleRunTask = async (taskId: string, taskName: string) => {
    toast.info(`正在执行任务: ${taskName}`);
    try {
      await runTask(taskId);
      toast.success(`任务「${taskName}」已启动`);
      // 刷新日志列表
      loadLogs(50);
    } catch (e) {
      toast.error('执行失败', e instanceof Error ? e.message : undefined);
    }
  };

  const handleToggleTask = async (task: ScheduledTask) => {
    try {
      await toggleTask(task.id, !task.enabled);

      if (task.enabled) {
        toast.success(`任务「${task.name}」已禁用`);
        return;
      }

      await runTask(task.id);
      toast.success(`任务「${task.name}」已启用并开始执行`);
      loadLogs(50);
    } catch (e) {
      toast.error(task.enabled ? '禁用失败' : '启用失败', e instanceof Error ? e.message : undefined);
    }
  };

  const handleDelete = (id: string) => {
    setConfirmDialog({
      show: true,
      title: '删除任务',
      message: '确定要删除这个任务吗？\n此操作不可撤销。',
      type: 'danger',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await deleteTask(id);
          toast.success('任务已删除');
        } catch (e) {
          toast.error('删除失败', e instanceof Error ? e.message : undefined);
        }
      },
    });
  };

  return (
    <div className="space-y-6">
      {/* 头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium text-text-primary">定时任务</h3>
          <p className="text-sm text-text-muted mt-1">创建定时执行的 AI 任务</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowTemplateManager(true)}
            className="px-4 py-2 bg-surface text-text-secondary hover:text-text-primary border border-border-subtle rounded transition-colors"
          >
            模板管理
          </button>
          <button
            onClick={() => {
              setEditingTask(undefined);
              setShowEditor(true);
            }}
            className="px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded transition-colors"
          >
            + 新建任务
          </button>
        </div>
      </div>

      {/* 调度器锁状态 */}
      {lockStatus && (
        <div className={`p-3 rounded-lg border ${
          lockStatus.isHolder
            ? 'bg-green-500/10 border-green-500/30'
            : lockStatus.isLockedByOther
            ? 'bg-yellow-500/10 border-yellow-500/30'
            : 'bg-gray-500/10 border-gray-500/30'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className={`w-2.5 h-2.5 rounded-full ${
                lockStatus.isHolder
                  ? 'bg-green-500'
                  : lockStatus.isLockedByOther
                  ? 'bg-yellow-500'
                  : 'bg-gray-500'
              }`} />
              <div>
                <p className={`text-sm font-medium ${
                  lockStatus.isHolder
                    ? 'text-green-400'
                    : lockStatus.isLockedByOther
                    ? 'text-yellow-400'
                    : 'text-gray-400'
                }`}>
                  {lockStatus.isHolder
                    ? '调度器运行中'
                    : lockStatus.isLockedByOther
                    ? '其他实例正在调度'
                    : '调度器未运行'}
                </p>
                <p className="text-xs text-text-muted">
                  PID: {lockStatus.pid}
                  {lockStatus.isHolder && (
                    <span className="ml-2">· 当前实例负责执行定时任务</span>
                  )}
                  {!lockStatus.isHolder && lockStatus.isLockedByOther && (
                    <span className="ml-2">· 请在持有锁的实例中停止调度后再启动</span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {lockStatus.isHolder ? (
                <button
                  onClick={handleStopScheduler}
                  disabled={operating}
                  className="px-3 py-1.5 text-sm bg-red-500/20 text-red-400
                             hover:bg-red-500/30 rounded transition-colors
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {operating ? '停止中...' : '停止调度'}
                </button>
              ) : lockStatus.isLockedByOther ? (
                <button
                  onClick={handleStartScheduler}
                  disabled={operating}
                  className="px-3 py-1.5 text-sm bg-yellow-500/20 text-yellow-400
                             hover:bg-yellow-500/30 rounded transition-colors
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {operating ? '启动中...' : '尝试启动'}
                </button>
              ) : (
                <button
                  onClick={handleStartScheduler}
                  disabled={operating}
                  className="px-3 py-1.5 text-sm bg-green-500/20 text-green-400
                             hover:bg-green-500/30 rounded transition-colors
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {operating ? '启动中...' : '启动调度'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 切换视图 */}
      <div className="flex border-b border-border-subtle">
        <button
          onClick={() => setActiveView('tasks')}
          className={`px-4 py-2 text-sm transition-colors ${
            activeView === 'tasks'
              ? 'text-primary border-b-2 border-primary'
              : 'text-text-muted hover:text-text-primary'
          }`}
        >
          任务列表 ({tasks.length})
        </button>
        <button
          onClick={() => setActiveView('logs')}
          className={`px-4 py-2 text-sm transition-colors ${
            activeView === 'logs'
              ? 'text-primary border-b-2 border-primary'
              : 'text-text-muted hover:text-text-primary'
          }`}
        >
          执行日志 ({logs.length})
        </button>
      </div>

      {/* 内容 */}
      {loading ? (
        <div className="text-center text-text-muted py-8">加载中...</div>
      ) : activeView === 'tasks' ? (
        tasks.length === 0 ? (
          <div className="text-center text-text-muted py-8">
            暂无定时任务，点击右上角按钮创建
          </div>
        ) : (
          <div className="space-y-3">
            {tasks.map((task) => (
              <div key={task.id} className="bg-surface rounded-lg p-4 border border-border-subtle">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${task.enabled ? 'bg-green-500' : 'bg-gray-500'}`} />
                      <span className="text-text-primary font-medium">{task.name}</span>
                    </div>
                    <div className="mt-2 text-sm text-text-muted space-y-1">
                      <p>触发: {TriggerTypeLabels[task.triggerType]} - {task.triggerValue}</p>
                      <p>引擎: {task.engineId}</p>
                      <div className="flex items-center gap-4">
                        <span>状态: <StatusBadge status={task.lastRunStatus} /></span>
                        {task.enabled && task.nextRunAt && (
                          <span>下次: {formatRelativeTime(task.nextRunAt)}</span>
                        )}
                        {/* 执行轮次显示 */}
                        {task.maxRuns != null && task.maxRuns > 0 && (
                          <span>
                            轮次:
                            <span className={task.currentRuns >= task.maxRuns ? 'text-yellow-400 ml-1' : 'text-text-secondary ml-1'}>
                              {task.currentRuns}/{task.maxRuns}
                            </span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleRunTask(task.id, task.name)}
                      className="px-3 py-1 text-sm bg-primary/20 text-primary hover:bg-primary/30 rounded transition-colors"
                    >
                      执行
                    </button>
                    <button
                      onClick={() => handleToggleTask(task)}
                      className={`px-3 py-1 text-sm rounded transition-colors ${
                        task.enabled
                          ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30'
                          : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                      }`}
                    >
                      {task.enabled ? '禁用' : '启用'}
                    </button>
                    <button
                      onClick={() => {
                        setEditingTask(task);
                        setShowEditor(true);
                      }}
                      className="px-3 py-1 text-sm bg-surface text-text-secondary hover:text-text-primary rounded transition-colors"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => handleDelete(task.id)}
                      className="px-3 py-1 text-sm bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded transition-colors"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="space-y-2">
          {logs.length === 0 ? (
            <div className="text-center text-text-muted py-8">暂无执行日志</div>
          ) : (
            logs.map((log) => (
              <div key={log.id} className="bg-surface rounded-lg p-3 border border-border-subtle">
                <div
                  className="flex items-center justify-between cursor-pointer"
                  onClick={() => setExpandedLogId(expandedLogId === log.id ? null : log.id)}
                >
                  <div className="flex items-center gap-3">
                    <StatusBadge status={log.status} />
                    <span className="text-text-primary">{log.taskName}</span>
                  </div>
                  <div className="text-sm text-text-muted">
                    {formatTime(log.startedAt)}
                    {log.finishedAt && <span className="ml-2">耗时 {log.finishedAt - log.startedAt}s</span>}
                  </div>
                </div>
                {expandedLogId === log.id && (
                  <div className="mt-3 pt-3 border-t border-border-subtle">
                    {/* 显示增强字段：Session ID、工具调用次数 */}
                    <div className="flex flex-wrap gap-4 text-xs text-text-muted mb-3">
                      {log.sessionId && (
                        <span>
                          Session: <code className="text-primary bg-background px-1 rounded">{log.sessionId.slice(0, 8)}...</code>
                        </span>
                      )}
                      {log.toolCallCount != null && log.toolCallCount > 0 && (
                        <span className="text-yellow-400">
                          工具调用: {log.toolCallCount} 次
                        </span>
                      )}
                    </div>
                    {/* 提示词 - 默认折叠 */}
                    <CollapsibleContent
                      label="提示词"
                      content={log.prompt}
                      maxHeight={60}
                      className="text-text-secondary"
                    />
                    {log.thinkingSummary && (
                      <CollapsibleContent
                        label="思考过程"
                        content={log.thinkingSummary}
                        maxHeight={80}
                        className="text-purple-400"
                      />
                    )}
                    {log.output && (
                      <CollapsibleContent
                        label="输出"
                        content={log.output}
                        maxHeight={120}
                        className="text-green-400"
                      />
                    )}
                    {log.error && (
                      <CollapsibleContent
                        label="错误"
                        content={log.error}
                        maxHeight={80}
                        className="text-red-400"
                      />
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* 编辑弹窗 */}
      {showEditor && (
        <TaskEditor
          task={editingTask}
          onSave={editingTask ? handleUpdate : handleCreate}
          onClose={() => {
            setShowEditor(false);
            setEditingTask(undefined);
          }}
          fullMode={false}
          title={editingTask ? '编辑任务' : '新建任务'}
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

      {/* 模板管理弹窗 */}
      {showTemplateManager && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background-elevated rounded-xl w-full max-w-3xl max-h-[85vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-text-primary">协议模板管理</h2>
              <button
                onClick={() => setShowTemplateManager(false)}
                className="text-gray-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <ProtocolTemplateManager />
          </div>
        </div>
      )}
    </div>
  );
}
