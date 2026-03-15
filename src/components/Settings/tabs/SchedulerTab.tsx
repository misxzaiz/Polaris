/**
 * 定时任务设置 Tab
 */

import { useEffect, useState } from 'react';
import { useSchedulerStore } from '../../../stores';
import { schedulerGetLockStatus, schedulerResetLock } from '../../../services/tauri';
import type { ScheduledTask, TriggerType, CreateTaskParams, LockStatus } from '../../../types/scheduler';
import { TriggerTypeLabels, IntervalUnitLabels, parseIntervalValue } from '../../../types/scheduler';

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

/** 任务编辑弹窗 */
function TaskEditor({
  task,
  onSave,
  onClose,
}: {
  task?: ScheduledTask;
  onSave: (params: CreateTaskParams) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(task?.name || '');
  const [triggerType, setTriggerType] = useState<TriggerType>(task?.triggerType || 'interval');
  const [triggerValue, setTriggerValue] = useState(task?.triggerValue || '1h');
  const [engineId, setEngineId] = useState(task?.engineId || 'claude');
  const [prompt, setPrompt] = useState(task?.prompt || '');
  const [workDir, setWorkDir] = useState(task?.workDir || '');

  const [intervalNum, setIntervalNum] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState<'s' | 'm' | 'h' | 'd'>('h');

  useEffect(() => {
    if (triggerType === 'interval') {
      const parsed = parseIntervalValue(triggerValue);
      if (parsed) {
        setIntervalNum(parsed.num);
        setIntervalUnit(parsed.unit);
      }
    }
  }, [triggerType, triggerValue]);

  const handleIntervalChange = (num: number, unit: 's' | 'm' | 'h' | 'd') => {
    setIntervalNum(num);
    setIntervalUnit(unit);
    setTriggerValue(`${num}${unit}`);
  };

  const handleSave = () => {
    if (!name.trim() || !prompt.trim()) {
      alert('请填写任务名称和提示词');
      return;
    }

    onSave({
      name,
      triggerType,
      triggerValue,
      engineId,
      prompt,
      workDir: workDir || undefined,
      enabled: task?.enabled ?? true,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#16162a] rounded-lg w-[550px] max-h-[80vh] overflow-y-auto border border-[#2a2a4a]">
        <div className="p-4 border-b border-[#2a2a4a] flex items-center justify-between">
          <h2 className="text-lg font-medium text-text-primary">
            {task ? '编辑任务' : '新建任务'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">任务名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:border-primary"
              placeholder="例如：每日日报生成"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">触发方式</label>
            <div className="flex gap-2">
              <select
                value={triggerType}
                onChange={(e) => setTriggerType(e.target.value as TriggerType)}
                className="px-3 py-2 bg-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:border-primary"
              >
                {Object.entries(TriggerTypeLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>

              {triggerType === 'interval' ? (
                <div className="flex gap-2 flex-1">
                  <input
                    type="number"
                    value={intervalNum}
                    onChange={(e) => handleIntervalChange(parseInt(e.target.value) || 1, intervalUnit)}
                    min={1}
                    className="w-24 px-3 py-2 bg-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:border-primary"
                  />
                  <select
                    value={intervalUnit}
                    onChange={(e) => handleIntervalChange(intervalNum, e.target.value as 's' | 'm' | 'h' | 'd')}
                    className="px-3 py-2 bg-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:border-primary"
                  >
                    {Object.entries(IntervalUnitLabels).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
              ) : triggerType === 'cron' ? (
                <input
                  type="text"
                  value={triggerValue}
                  onChange={(e) => setTriggerValue(e.target.value)}
                  className="flex-1 px-3 py-2 bg-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:border-primary font-mono"
                  placeholder="0 9 * * 1-5"
                />
              ) : (
                <input
                  type="datetime-local"
                  value={triggerValue}
                  onChange={(e) => setTriggerValue(e.target.value)}
                  className="flex-1 px-3 py-2 bg-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:border-primary"
                />
              )}
            </div>
            {triggerType === 'cron' && (
              <p className="mt-1 text-xs text-text-muted">示例: "0 9 * * 1-5" 表示工作日早9点</p>
            )}
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">AI 引擎</label>
            <select
              value={engineId}
              onChange={(e) => setEngineId(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:border-primary"
            >
              <option value="claude">Claude Code</option>
              <option value="iflow">IFlow</option>
              <option value="codex">Codex</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">工作目录（可选）</label>
            <input
              type="text"
              value={workDir}
              onChange={(e) => setWorkDir(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:border-primary"
              placeholder="留空使用默认目录"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">提示词</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              className="w-full px-3 py-2 bg-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:border-primary resize-none"
              placeholder="输入 AI 要执行的提示词..."
            />
          </div>
        </div>

        <div className="p-4 border-t border-[#2a2a4a] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-surface text-text-secondary hover:text-text-primary rounded transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

/** 主组件 */
export function SchedulerTab() {
  const { tasks, logs, loading, loadTasks, loadLogs, createTask, updateTask, deleteTask, toggleTask, runTask } =
    useSchedulerStore();

  const [showEditor, setShowEditor] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | undefined>();
  const [activeView, setActiveView] = useState<'tasks' | 'logs'>('tasks');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [lockStatus, setLockStatus] = useState<LockStatus | null>(null);
  const [resetting, setResetting] = useState(false);

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
      console.error('获取锁状态失败:', e);
    }
  };

  const handleResetLock = async () => {
    if (!confirm('确定要重置调度器锁吗？如果其他实例正在运行调度任务，可能会导致重复执行。')) return;

    setResetting(true);
    try {
      const result = await schedulerResetLock();
      alert(result);
      await loadLockStatus();
    } catch (e) {
      alert(e instanceof Error ? e.message : '重置失败');
    } finally {
      setResetting(false);
    }
  };

  const handleCreate = async (params: CreateTaskParams) => {
    try {
      await createTask(params);
      setShowEditor(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : '创建失败');
    }
  };

  const handleUpdate = async (params: CreateTaskParams) => {
    if (!editingTask) return;
    try {
      await updateTask({
        ...editingTask,
        ...params,
      });
      setShowEditor(false);
      setEditingTask(undefined);
    } catch (e) {
      alert(e instanceof Error ? e.message : '更新失败');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除这个任务吗？')) return;
    try {
      await deleteTask(id);
    } catch (e) {
      alert(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div className="space-y-6">
      {/* 头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium text-text-primary">定时任务</h3>
          <p className="text-sm text-text-muted mt-1">创建定时执行的 AI 任务</p>
        </div>
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
                    ? '当前实例负责调度'
                    : lockStatus.isLockedByOther
                    ? '其他实例正在调度'
                    : '无调度器运行'}
                </p>
                <p className="text-xs text-text-muted">
                  PID: {lockStatus.pid}
                  {!lockStatus.isHolder && lockStatus.isLockedByOther && (
                    <span className="ml-2">· 定时任务将由其他实例执行</span>
                  )}
                </p>
              </div>
            </div>
            {!lockStatus.isHolder && (
              <button
                onClick={handleResetLock}
                disabled={resetting}
                className="px-3 py-1.5 text-sm bg-yellow-500/20 text-yellow-400
                           hover:bg-yellow-500/30 rounded transition-colors
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {resetting ? '重置中...' : '接管调度'}
              </button>
            )}
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
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => runTask(task.id)}
                      className="px-3 py-1 text-sm bg-primary/20 text-primary hover:bg-primary/30 rounded transition-colors"
                    >
                      执行
                    </button>
                    <button
                      onClick={() => toggleTask(task.id, !task.enabled)}
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
                    <div className="text-sm text-text-muted mb-2">提示词:</div>
                    <pre className="text-xs text-text-secondary bg-background p-2 rounded overflow-x-auto whitespace-pre-wrap">
                      {log.prompt}
                    </pre>
                    {log.output && (
                      <>
                        <div className="text-sm text-text-muted mt-3 mb-2">输出:</div>
                        <pre className="text-xs text-green-400 bg-background p-2 rounded overflow-x-auto whitespace-pre-wrap max-h-60">
                          {log.output}
                        </pre>
                      </>
                    )}
                    {log.error && (
                      <>
                        <div className="text-sm text-text-muted mt-3 mb-2">错误:</div>
                        <pre className="text-xs text-red-400 bg-background p-2 rounded overflow-x-auto whitespace-pre-wrap">
                          {log.error}
                        </pre>
                      </>
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
        />
      )}
    </div>
  );
}
