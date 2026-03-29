/**
 * TodoCard - 单个待办卡片
 */

import { Circle, Clock, CheckCircle, Calendar, Timer, Edit, Globe, FolderOpen, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PriorityIcon } from './PriorityIcon'
import type { TodoItem } from '@/types'

interface TodoCardProps {
  todo: TodoItem
  onEditClick?: (todo: TodoItem) => void
  onToggleStatus?: (todo: TodoItem) => void
  onDeleteClick?: (todo: TodoItem) => void
}

export function TodoCard({ todo, onEditClick, onToggleStatus, onDeleteClick }: TodoCardProps) {
  const { t } = useTranslation('todo')

  // Determine workspace info from new fields
  const isGlobal = !todo.workspacePath
  const workspaceDisplayName = todo.workspaceName || (isGlobal ? t('card.globalTodo') : null)

  const statusConfig = {
    pending: {
      icon: Circle,
      color: 'text-text-tertiary',
      bg: 'bg-background-tertiary',
      labelKey: 'status.pending',
    },
    in_progress: {
      icon: Clock,
      color: 'text-primary',
      bg: 'bg-primary/10',
      labelKey: 'status.inProgress',
    },
    completed: {
      icon: CheckCircle,
      color: 'text-green-500',
      bg: 'bg-green-500/10',
      labelKey: 'status.completed',
    },
    cancelled: {
      icon: CheckCircle,
      color: 'text-text-tertiary',
      bg: 'bg-background-tertiary',
      labelKey: 'status.cancelled',
    },
  }[todo.status]

  const priorityConfig = {
    urgent: { labelKey: 'priority.urgent' },
    high: { labelKey: 'priority.high' },
    normal: { labelKey: 'priority.normal' },
    low: { labelKey: 'priority.low' },
  }[todo.priority] || { labelKey: 'priority.normal' }

  const StatusIcon = statusConfig.icon

  const completedSubtasks = todo.subtasks ? todo.subtasks.filter((st) => st.completed).length : 0
  const totalSubtasks = todo.subtasks?.length || 0
  const subtaskProgress = totalSubtasks > 0 ? (completedSubtasks / totalSubtasks) * 100 : 0

  const handleToggleStatus = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onToggleStatus) {
      onToggleStatus(todo)
    }
  }

  return (
    <div
      className={`p-3 rounded-lg border transition-all hover:shadow-sm ${
        todo.status === 'in_progress'
          ? 'bg-primary/5 border-primary/30'
          : todo.status === 'completed'
          ? 'bg-green-500/5 border-green-500/30 opacity-60'
          : 'bg-background-surface border-border-subtle hover:border-border'
      }`}
    >
      <div className="flex items-start gap-2">
        <button
          onClick={handleToggleStatus}
          className={`p-1 rounded ${statusConfig.bg} ${statusConfig.color} hover:opacity-80 transition-all`}
          title={t(statusConfig.labelKey)}
        >
          <StatusIcon size={16} />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`text-sm break-words ${
                todo.status === 'completed' ? 'line-through text-text-tertiary' : 'text-text-primary'
              }`}
            >
              {todo.content || t('card.noContent')}
            </span>
            <span className="text-xs" title={t(priorityConfig.labelKey)}>
              <PriorityIcon priority={todo.priority} size={14} />
            </span>
          </div>

          {todo.tags && todo.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 mt-1.5">
              {todo.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-1.5 py-0.5 text-xs text-text-tertiary bg-background-tertiary rounded"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {isGlobal ? (
            <div className="mt-1.5 flex items-center gap-1 text-xs text-blue-500">
              <Globe size={12} />
              <span>{t('card.globalTodo')}</span>
            </div>
          ) : workspaceDisplayName && (
            <div className="mt-1.5 flex items-center gap-1 text-xs text-purple-500">
              <FolderOpen size={12} />
              <span>{workspaceDisplayName}</span>
            </div>
          )}

          {todo.dueDate && (
            <div className="mt-1.5 flex items-center gap-1 text-xs">
              <Calendar size={12} />
              <span className={new Date(todo.dueDate) < new Date() ? 'text-red-500 font-medium' : 'text-text-secondary'}>
                {new Date(todo.dueDate).toLocaleDateString('zh-CN', {
                  month: 'short',
                  day: 'numeric',
                })}
                {new Date(todo.dueDate) < new Date() && ` (${t('card.overdue')})`}
              </span>
            </div>
          )}

          {todo.estimatedHours && (
            <div className="mt-1 flex items-center gap-1 text-xs text-text-secondary">
              <Timer size={12} />
              <span>
                {todo.spentHours || 0} / {todo.estimatedHours}h
              </span>
              {todo.estimatedHours && todo.spentHours && (
                <div className="flex-1 ml-2 bg-background-tertiary rounded-full h-1.5 max-w-[60px]">
                  <div
                    className="bg-primary h-1.5 rounded-full"
                    style={{ width: `${Math.min((todo.spentHours / todo.estimatedHours) * 100, 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {todo.status === 'in_progress' && todo.lastProgress && (
            <div className="mt-2 text-xs text-text-secondary">
              {todo.lastProgress}
            </div>
          )}

          {todo.relatedFiles && todo.relatedFiles.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {todo.relatedFiles.map((file) => (
                <span
                  key={file}
                  className="px-1.5 py-0.5 text-xs text-blue-500 bg-blue-500/10 rounded font-mono max-w-[120px] truncate"
                  title={file}
                >
                  {file.split('/').pop()}
                </span>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation()
            onEditClick?.(todo)
          }}
          className="p-1.5 rounded hover:bg-background-hover text-text-secondary hover:text-text-primary transition-all"
          title={t('card.editTodo')}
        >
          <Edit size={14} />
        </button>

        {onDeleteClick && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (confirm(t('card.deleteConfirm', { content: todo.content }))) {
                onDeleteClick(todo)
              }
            }}
            className="p-1.5 rounded hover:bg-red-500/10 text-text-secondary hover:text-red-500 transition-all"
            title={t('card.deleteTodo')}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {totalSubtasks > 0 && (
        <div className="mt-3 group/">
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <div className="flex-1 bg-background-tertiary rounded-full h-1.5">
              <div
                className="bg-primary h-1.5 rounded-full transition-all"
                style={{ width: `${subtaskProgress}%` }}
              />
            </div>
            <span className="whitespace-nowrap">
              {completedSubtasks}/{totalSubtasks}
            </span>
            <span className="text-text-muted">({Math.round(subtaskProgress)}%)</span>
          </div>

          <div className="mt-1.5 flex items-center gap-1 flex-wrap text-xs text-text-secondary">
            {todo.subtasks?.map((subtask, idx) => (
              <span
                key={subtask.id}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded max-w-[150px] truncate ${
                  subtask.completed
                    ? 'bg-green-500/10 text-green-500 line-through'
                    : 'bg-background-tertiary'
                }`}
                title={subtask.title}
              >
                <span className="w-3 h-3 rounded-full border flex items-center justify-center text-[10px]">
                  {idx + 1}
                </span>
                {subtask.title}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-2 text-xs text-text-muted">
        {new Date(todo.createdAt).toLocaleString('zh-CN', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </div>
    </div>
  )
}
