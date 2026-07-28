/**
 * DesktopTasks — 连接桌面端后的任务管理页面
 *
 * 参考 polaris-mobile MobileTasks.tsx 的 HTTP 调用模式。
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { clsx } from 'clsx';
import {
  listTodos,
  completeTodo,
  listSchedulerTasks,
  runSchedulerTask,
  type TodoItem,
  type ScheduledTask,
} from '../services/desktopClient';

export function DesktopTasks() {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextTodos, nextTasks] = await Promise.all([
        listTodos(null).catch(() => []),
        listSchedulerTasks(null).catch(() => []),
      ]);
      setTodos(nextTodos);
      setTasks(nextTasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const activeTodos = useMemo(
    () => todos.filter((todo) => todo.status !== 'completed' && todo.status !== 'cancelled').slice(0, 20),
    [todos],
  );
  const enabledTasks = useMemo(() => tasks.filter((task) => task.enabled).slice(0, 20), [tasks]);

  const handleComplete = async (todo: TodoItem) => {
    setBusyId(todo.id);
    setError(null);
    try {
      await completeTodo(todo.id, todo.workspacePath || null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleRun = async (task: ScheduledTask) => {
    setBusyId(task.id);
    setError(null);
    try {
      await runSchedulerTask(task.id, task.workDir || null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">任务调度</h2>
          <p className="text-[10px] text-text-tertiary">桌面端 Todo 与定时任务</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-full border border-border p-2 text-text-secondary"
          aria-label="刷新"
        >
          <span className={clsx('inline-block', loading && 'animate-spin')}>⟳</span>
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[11px] text-danger">{error}</div>
      )}

      {/* Todo */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-medium text-text-secondary">待办</h3>
        {activeTodos.length === 0 && !loading && (
          <div className="text-[11px] text-text-tertiary">暂无待办</div>
        )}
        <div className="space-y-2">
          {activeTodos.map((todo) => (
            <div key={todo.id} className="rounded-xl border border-border bg-background-elevated p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-medium text-text-primary">{todo.content}</div>
                  {todo.description && (
                    <div className="mt-1 line-clamp-2 text-[10px] text-text-tertiary">{todo.description}</div>
                  )}
                </div>
                <span className="shrink-0 rounded bg-background-surface px-1.5 py-0.5 text-[9px] text-text-tertiary">
                  {todo.priority}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleComplete(todo)}
                disabled={busyId === todo.id}
                className="mt-2 inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] text-text-secondary disabled:opacity-40"
              >
                ✓ 完成
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 定时任务 */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-medium text-text-secondary">自动化</h3>
        {enabledTasks.length === 0 && !loading && (
          <div className="text-[11px] text-text-tertiary">暂无启用的定时任务</div>
        )}
        <div className="space-y-2">
          {enabledTasks.map((task) => (
            <div key={task.id} className="rounded-xl border border-border bg-background-elevated p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-medium text-text-primary">{task.name}</div>
                  <div className="mt-1 truncate text-[10px] text-text-tertiary">{task.description || task.prompt}</div>
                </div>
                <span className="shrink-0 rounded bg-background-surface px-1.5 py-0.5 text-[9px] text-text-tertiary">
                  {task.engineId}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleRun(task)}
                disabled={busyId === task.id}
                className="mt-2 inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] text-text-secondary disabled:opacity-40"
              >
                ▶ 运行
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}