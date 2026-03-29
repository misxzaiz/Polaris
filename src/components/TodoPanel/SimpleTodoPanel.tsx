/**
 * 简化的待办面板
 */

import { useState, useEffect } from 'react'
import { Plus, CheckCircle, Circle, Clock, Search, ArrowUpDown, Globe, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '@/stores'
import { simpleTodoService } from '@/services/simpleTodoService'
import { TodoCard } from './TodoCard'
import { TodoDetailDialog } from './TodoDetailDialog'
import { TodoForm } from './TodoForm'
import type { TodoItem, TodoStatus, TodoPriority } from '@/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('SimpleTodoPanel')

export function SimpleTodoPanel() {
  const { t } = useTranslation('todo')
  const currentWorkspace = useWorkspaceStore(state => state.getCurrentWorkspace())
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'in_progress' | 'completed'>('all')
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [selectedTodo, setSelectedTodo] = useState<TodoItem | null>(null)

  // 范围切换：工作区 / 全部
  const [scope, setScope] = useState<'workspace' | 'all'>('workspace')

  // 搜索和排序相关
  const [searchQuery, setSearchQuery] = useState('')
  type SortByType = 'createdAt' | 'dueDate' | 'priority'
  type SortOrderType = 'desc' | 'asc'
  const [sortBy, setSortBy] = useState<SortByType>('createdAt')
  const [sortOrder, setSortOrder] = useState<SortOrderType>('desc')

  // 标签相关
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')

  // 初始化:加载工作区待办
  useEffect(() => {
    if (!currentWorkspace) {
      setTodos([])
      return
    }

    // 设置工作区并加载待办
    simpleTodoService.setWorkspace(currentWorkspace.path).then(() => {
      simpleTodoService.setScope(scope)
      refreshTodos()
    })

    // 订阅变化
    const unsubscribe = simpleTodoService.subscribe(refreshTodos)

    return () => {
      unsubscribe()
    }
  }, [currentWorkspace])

  // 范围变化时刷新
  useEffect(() => {
    simpleTodoService.setScope(scope)
  }, [scope])

  // 优先级权重（用于排序）
  const priorityWeight: Record<TodoPriority, number> = {
    urgent: 4,
    high: 3,
    normal: 2,
    low: 1,
  }

  // 刷新待办列表（包含搜索、筛选、排序逻辑）
  const refreshTodos = () => {
    let result = simpleTodoService.getAllTodos()

    // 1. 状态筛选
    if (statusFilter !== 'all') {
      result = result.filter(t => t.status === statusFilter)
    }

    // 2. 搜索过滤
    if (searchQuery.trim()) {
      const keyword = searchQuery.toLowerCase()
      result = result.filter(t =>
        t.content.toLowerCase().includes(keyword) ||
        t.description?.toLowerCase().includes(keyword) ||
        t.tags?.some(tag => tag.toLowerCase().includes(keyword))
      )
    }

    // 3. 排序
    result = result.sort((a, b) => {
      let compareResult = 0

      if (sortBy === 'createdAt') {
        compareResult = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      } else if (sortBy === 'dueDate') {
        // 没有截止日期的放到最后
        const aDate = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_VALUE
        const bDate = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_VALUE
        compareResult = aDate - bDate
      } else if (sortBy === 'priority') {
        compareResult = priorityWeight[a.priority] - priorityWeight[b.priority]
      }

      return sortOrder === 'desc' ? -compareResult : compareResult
    })

    setTodos(result)
  }

  // 当筛选、搜索、排序变化时刷新
  useEffect(() => {
    refreshTodos()
  }, [statusFilter, searchQuery, sortBy, sortOrder])

  // 创建待办
  const handleCreateTodo = async (data: {
    content: string
    description?: string
    priority: TodoPriority
    dueDate?: string
    estimatedHours?: number
    subtasks?: { title: string }[]
    isGlobal?: boolean
  }) => {
    try {
      await simpleTodoService.createTodo({
        content: data.content,
        description: data.description,
        priority: data.priority,
        dueDate: data.dueDate,
        estimatedHours: data.estimatedHours,
        subtasks: data.subtasks,
        tags: tags.length > 0 ? tags : undefined,
        isGlobal: data.isGlobal,
      })

      setTags([])
      setTagInput('')
      setShowCreateDialog(false)
      await refreshTodos()
    } catch (error) {
      console.error(t('errors.createFailed'), error)
      alert(t('errors.createFailed') + ': ' + (error as Error).message)
    }
  }

  const handleAddTag = () => {
    const tag = tagInput.trim().toLowerCase()
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag])
      setTagInput('')
    }
  }

  const handleRemoveTag = (tag: string) => {
    setTags(tags.filter(t => t !== tag))
  }

  const handleToggleStatus = async (todo: TodoItem) => {
    const statusFlow: Record<TodoItem['status'], TodoStatus> = {
      pending: 'in_progress',
      in_progress: 'completed',
      completed: 'pending',
      cancelled: 'pending',
    }

    try {
      await simpleTodoService.updateTodo(todo.id, {
        status: statusFlow[todo.status],
      })
      refreshTodos()
    } catch (error) {
      console.error(t('errors.updateFailed'), error)
    }
  }

  const handleDeleteTodo = async (todo: TodoItem) => {
    try {
      await simpleTodoService.deleteTodo(todo.id)
      refreshTodos()
    } catch (error) {
      log.error(t('errors.deleteFailed'), error instanceof Error ? error : new Error(String(error)))
      alert(t('errors.deleteFailed') + ': ' + (error as Error).message)
    }
  }

  const stats = simpleTodoService.getStats()

  if (!currentWorkspace) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary">
        <div className="text-center">
          <p>{t('noWorkspace')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-background-elevated">
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('title')}
            <span className="ml-2 text-xs font-normal text-text-secondary">
              ({stats.pending} {t('stats.pending')} / {stats.inProgress} {t('stats.inProgress')})
            </span>
          </h2>
          <button
            onClick={() => setShowCreateDialog(true)}
            className="p-1.5 rounded-lg bg-primary text-white hover:bg-primary/90 transition-all"
            title={t('createTodo')}
          >
            <Plus size={16} />
          </button>
        </div>

        {/* 范围切换 */}
        <div className="flex items-center gap-1 mb-3">
          <button
            onClick={() => setScope('workspace')}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-all ${
              scope === 'workspace'
                ? 'bg-primary/20 text-primary'
                : 'hover:bg-background-hover text-text-secondary'
            }`}
          >
            <FolderOpen size={12} />
            {t('scope.workspace', '当前工作区')}
          </button>
          <button
            onClick={() => setScope('all')}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-all ${
              scope === 'all'
                ? 'bg-primary/20 text-primary'
                : 'hover:bg-background-hover text-text-secondary'
            }`}
          >
            <Globe size={12} />
            {t('scope.all', '全部')}
          </button>
        </div>

        <div className="mb-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="w-full pl-9 pr-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 text-text-primary placeholder-text-tertiary"
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1 flex-wrap">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-2 py-1 text-xs rounded whitespace-nowrap transition-all ${
                statusFilter === 'all'
                  ? 'bg-primary text-white'
                  : 'hover:bg-background-hover text-text-secondary'
              }`}
            >
              {t('status.all')}
            </button>
            <button
              onClick={() => setStatusFilter('pending')}
              className={`px-2 py-1 text-xs rounded flex items-center gap-1 whitespace-nowrap transition-all ${
                statusFilter === 'pending'
                  ? 'bg-primary text-white'
                  : 'hover:bg-background-hover text-text-secondary'
              }`}
            >
              <Circle size={12} />
              {t('status.pending')}
            </button>
            <button
              onClick={() => setStatusFilter('in_progress')}
              className={`px-2 py-1 text-xs rounded flex items-center gap-1 whitespace-nowrap transition-all ${
                statusFilter === 'in_progress'
                  ? 'bg-primary text-white'
                  : 'hover:bg-background-hover text-text-secondary'
              }`}
            >
              <Clock size={12} />
              {t('status.inProgress')}
            </button>
            <button
              onClick={() => setStatusFilter('completed')}
              className={`px-2 py-1 text-xs rounded flex items-center gap-1 whitespace-nowrap transition-all ${
                statusFilter === 'completed'
                  ? 'bg-primary text-white'
                  : 'hover:bg-background-hover text-text-secondary'
              }`}
            >
              <CheckCircle size={12} />
              {t('status.completed')}
            </button>
          </div>

          <div className="flex items-center justify-end gap-1">
            <ArrowUpDown size={14} className="text-text-tertiary flex-shrink-0" />
            <select
              value={`${sortBy}-${sortOrder}`}
              onChange={(e) => {
                const [newSortBy, newSortOrder] = e.target.value.split('-') as [SortByType, SortOrderType]
                setSortBy(newSortBy)
                setSortOrder(newSortOrder)
              }}
              className="px-2 py-1 text-xs bg-background-surface border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary/50 text-text-secondary cursor-pointer max-w-[200px]"
            >
              <option value="createdAt-desc">{t('sort.newest')}</option>
              <option value="createdAt-asc">{t('sort.oldest')}</option>
              <option value="dueDate-asc">{t('sort.dueDateAsc')}</option>
              <option value="dueDate-desc">{t('sort.dueDateDesc')}</option>
              <option value="priority-desc">{t('sort.priorityDesc')}</option>
              <option value="priority-asc">{t('sort.priorityAsc')}</option>
            </select>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
        {todos.map(todo => (
          <TodoCard
            key={todo.id}
            todo={todo}
            onEditClick={setSelectedTodo}
            onToggleStatus={handleToggleStatus}
            onDeleteClick={handleDeleteTodo}
          />
        ))}

        {todos.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
            <CheckCircle size={48} className="mb-3 opacity-50" />
            <p className="text-sm">
              {statusFilter === 'all' ? t('noTodos') : t('noTodosWithFilter', { status: getStatusLabel(statusFilter, t) })}
            </p>
            <button
              onClick={() => setShowCreateDialog(true)}
              className="mt-4 px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 transition-all"
            >
              {t('createTodo')}
            </button>
          </div>
        )}
      </div>

      {showCreateDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <TodoForm
            mode="create"
            onSubmit={handleCreateTodo}
            onCancel={() => {
              setShowCreateDialog(false)
              setTags([])
              setTagInput('')
            }}
            tags={tags}
            onAddTag={handleAddTag}
            onRemoveTag={handleRemoveTag}
          />
        </div>
      )}

      {selectedTodo && (
        <TodoDetailDialog
          todo={selectedTodo}
          open={!!selectedTodo}
          onClose={() => setSelectedTodo(null)}
          onUpdate={() => {
            refreshTodos()
            setSelectedTodo(null)
          }}
          onDelete={() => {
            handleDeleteTodo(selectedTodo)
            setSelectedTodo(null)
          }}
        />
      )}
    </div>
  )
}

function getStatusLabel(status: 'all' | 'pending' | 'in_progress' | 'completed', t: (key: string) => string): string {
  const labels = {
    all: '',
    pending: t('status.pending'),
    in_progress: t('status.inProgress'),
    completed: t('status.completed'),
  }
  return labels[status]
}
