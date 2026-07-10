import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Play, RefreshCw } from 'lucide-react';
import { invoke } from '@/services/transport';
import type { ScheduledTask, TodoItem } from '@/types';

interface MobileTasksProps {
  workspacePath?: string | null;
}

export function MobileTasks({ workspacePath }: MobileTasksProps) {
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
        invoke<TodoItem[]>('list_todos', {
          params: { scope: 'workspace', workspacePath: workspacePath || null },
        }).catch(() => []),
        invoke<ScheduledTask[]>('scheduler_list_tasks', {
          workspacePath: workspacePath || null,
        }).catch(() => []),
      ]);
      setTodos(nextTodos);
      setTasks(nextTasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeTodos = useMemo(
    () => todos.filter(todo => todo.status !== 'completed' && todo.status !== 'cancelled').slice(0, 20),
    [todos],
  );
  const enabledTasks = useMemo(() => tasks.filter(task => task.enabled).slice(0, 20), [tasks]);

  const completeTodo = async (todo: TodoItem) => {
    setBusyId(todo.id);
    setError(null);
    try {
      await invoke('complete_todo', {
        params: { id: todo.id, workspacePath: workspacePath || todo.workspacePath || null },
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const runTask = async (task: ScheduledTask) => {
    setBusyId(task.id);
    setError(null);
    try {
      await invoke('scheduler_run_task', {
        id: task.id,
        workspacePath: workspacePath || task.workDir || null,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">任务</h2>
          <p className="text-xs text-text-tertiary">Todo 与 Scheduler 的移动聚合视图</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-full border border-border p-2 text-text-secondary"
          aria-label="刷新任务"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {error && <div className="rounded-xl border border-danger/30 bg-danger-faint px-3 py-2 text-sm text-danger">{error}</div>}

      <TaskSection title="待办" emptyText="暂无待办">
        {activeTodos.map(todo => (
          <div key={todo.id} className="rounded-2xl border border-border bg-background-elevated p-4 shadow-soft">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-primary">{todo.content}</div>
                {todo.description && <div className="mt-1 line-clamp-2 text-xs text-text-tertiary">{todo.description}</div>}
              </div>
              <span className="rounded-full bg-background-surface px-2 py-1 text-[10px] text-text-tertiary">{todo.priority}</span>
            </div>
            <button
              type="button"
              onClick={() => void completeTodo(todo)}
              disabled={busyId === todo.id}
              className="mt-3 inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-xs text-text-secondary disabled:opacity-50"
            >
              <CheckCircle2 size={14} />
              完成
            </button>
          </div>
        ))}
      </TaskSection>

      <TaskSection title="自动化" emptyText="暂无启用的定时任务">
        {enabledTasks.map(task => (
          <div key={task.id} className="rounded-2xl border border-border bg-background-elevated p-4 shadow-soft">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-primary">{task.name}</div>
                <div className="mt-1 truncate text-xs text-text-tertiary">{task.description || task.prompt}</div>
              </div>
              <span className="rounded-full bg-background-surface px-2 py-1 text-[10px] text-text-tertiary">{task.engineId}</span>
            </div>
            <button
              type="button"
              onClick={() => void runTask(task)}
              disabled={busyId === task.id}
              className="mt-3 inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-xs text-text-secondary disabled:opacity-50"
            >
              <Play size={14} />
              运行
            </button>
          </div>
        ))}
      </TaskSection>
    </section>
  );
}

function TaskSection({ title, emptyText, children }: { title: string; emptyText: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children;
  const empty = Array.isArray(items) ? items.length === 0 : !items;

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-text-secondary">{title}</h3>
      {empty ? <div className="text-sm text-text-tertiary">{emptyText}</div> : items}
    </section>
  );
}
