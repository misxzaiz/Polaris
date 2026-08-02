/**
 * TodoWrite 输入渲染器 - 展开状态
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import type { TodoItemType } from '../chatUtils/types';
import { TODO_STATUS_CONFIG } from '../chatUtils/constants';

/**
 * TodoWrite 任务项组件
 */
const TodoItemComponent = memo(function TodoItemComponent({
  todo,
  index
}: {
  todo: TodoItemType;
  index: number;
}) {
  const { t } = useTranslation('chat');
  const statusConfig = TODO_STATUS_CONFIG[todo.status] || TODO_STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;

  return (
    <div className="flex items-start gap-2 p-2 rounded bg-background-surface hover:bg-background-hover transition-colors">
      <div className={clsx('p-1 rounded', statusConfig.bg)}>
        <StatusIcon className={clsx('w-3.5 h-3.5', statusConfig.color,
          todo.status === 'in_progress' && 'animate-spin'
        )} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary">{todo.content}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={clsx('text-xs', statusConfig.color)}>{t(statusConfig.labelKey)}</span>
          <span className="text-xs text-text-muted">#{index + 1}</span>
        </div>
      </div>
    </div>
  );
});

/**
 * TodoWrite 输入渲染器 - 展开状态
 */
export const TodoWriteInputRenderer = memo(function TodoWriteInputRenderer({
  data
}: {
  data: {
    todos: TodoItemType[];
    total: number;
    completed: number;
  };
}) {
  const percent = data.total > 0 ? Math.round((data.completed / data.total) * 100) : 0;

  return (
    <div className="space-y-3">
      {/* 进度条 */}
      <div className="flex items-center gap-3">
        <div className="flex-1 bg-background-base rounded-full h-2 overflow-hidden">
          <div
            className="bg-violet-500 h-full transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-xs text-text-tertiary">
          {data.completed}/{data.total} ({percent}%)
        </span>
      </div>

      {/* 任务列表 */}
      <div className="space-y-1">
        {data.todos.map((todo, index) => (
          <TodoItemComponent key={index} todo={todo} index={index} />
        ))}
      </div>
    </div>
  );
});
