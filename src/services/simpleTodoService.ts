/**
 * 统一待办服务
 *
 * 走 RouterBus dispatch（cap.todo 能力），支持全局和工作区双模式。
 * 命令层 list_todos/create_todo/... 已移除，所有 todo 操作经
 * `router_dispatch("cap.todo", ...)` 进入统一总线。
 */

import { invoke } from '@/services/transport'
import type { TodoItem, TodoPriority, TodoStatus } from '@/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('SimpleTodoService')

/**
 * router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应）
 */
interface DispatchResponse {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

/**
 * 统一待办服务
 */
export class SimpleTodoService {
  private workspacePath: string | null = null
  private scope: 'workspace' | 'all' = 'workspace'
  private todos: TodoItem[] = []
  private listeners: Set<() => void> = new Set()

  constructor() {
    // 初始化为空，通过 setWorkspace 设置工作区
  }

  /**
   * 获取当前工作区路径
   */
  getCurrentWorkspacePath(): string | null {
    return this.workspacePath
  }

  /**
   * 设置当前工作区
   * @param workspacePath 工作区路径
   * @param forceReload 是否强制重新加载（默认 false）
   * @returns 待办数量
   */
  async setWorkspace(workspacePath: string, forceReload: boolean = false): Promise<number> {
    // 如果工作区未切换且不强制重新加载，跳过
    if (!forceReload && this.workspacePath === workspacePath) {
      log.info('工作区未切换，跳过重新加载')
      return this.todos.length
    }

    this.workspacePath = workspacePath
    await this.loadTodos()
    return this.todos.length
  }

  /**
   * 设置查询范围
   */
  setScope(scope: 'workspace' | 'all'): void {
    if (this.scope !== scope) {
      this.scope = scope
      this.loadTodos()
    }
  }

  /**
   * 获取当前查询范围
   */
  getScope(): 'workspace' | 'all' {
    return this.scope
  }

  /**
   * 构造 dispatch 信封并调用 RouterBus（cap.todo）
   */
  private async dispatch(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await invoke<DispatchResponse>('router_dispatch', {
      req: {
        target: 'cap.todo',
        payload: {
          action,
          ...payload,
        },
      },
    })

    if (!res.ok) {
      throw new Error(res.error || `cap.todo ${action} 失败`)
    }
    return res.result || {}
  }

  /**
   * 从后端加载待办
   */
  private async loadTodos(): Promise<void> {
    try {
      const result = await this.dispatch('list', {
        scope: this.scope,
        workspacePath: this.workspacePath,
      })
      this.todos = (result.items as TodoItem[]) || []
      this.notifyListeners()
    } catch (error) {
      log.error('加载失败', error instanceof Error ? error : new Error(String(error)))
      this.todos = []
    }
  }

  /**
   * 刷新待办列表
   */
  async refresh(): Promise<void> {
    await this.loadTodos()
  }

  /**
   * 获取所有待办
   */
  getAllTodos(): TodoItem[] {
    return [...this.todos]
  }

  /**
   * 根据状态筛选
   */
  getTodosByStatus(status: 'all' | 'pending' | 'in_progress' | 'completed'): TodoItem[] {
    if (status === 'all') {
      return this.getAllTodos()
    }
    return this.todos.filter(t => t.status === status)
  }

  /**
   * 创建待办
   */
  async createTodo(params: {
    content: string
    description?: string
    priority?: TodoPriority
    tags?: string[]
    relatedFiles?: string[]
    dueDate?: string
    estimatedHours?: number
    subtasks?: { title: string }[]
  }): Promise<TodoItem> {
    const result = await this.dispatch('create', {
      content: params.content,
      description: params.description,
      priority: params.priority,
      tags: params.tags,
      relatedFiles: params.relatedFiles,
      dueDate: params.dueDate,
      estimatedHours: params.estimatedHours,
      subTasks: params.subtasks,
      workspacePath: this.workspacePath,
    })

    await this.loadTodos()
    return result.item as TodoItem
  }

  /**
   * 更新待办
   */
  async updateTodo(id: string, updates: {
    content?: string
    description?: string
    status?: TodoStatus
    priority?: TodoPriority
    tags?: string[]
    relatedFiles?: string[]
    dueDate?: string
    estimatedHours?: number
    spentHours?: number
    lastProgress?: string
    lastError?: string
    subtasks?: { id: string; title: string; completed: boolean; createdAt?: string }[]
  }): Promise<void> {
    const { subtasks, ...rest } = updates
    await this.dispatch('update', {
      id,
      ...rest,
      subTasks: subtasks as { id: string; title: string; completed: boolean; createdAt?: string }[] | undefined,
    })

    await this.loadTodos()
  }

  /**
   * 删除待办
   */
  async deleteTodo(id: string): Promise<void> {
    await this.dispatch('delete', { id })
    await this.loadTodos()
  }

  /**
   * 开始待办
   */
  async startTodo(id: string, lastProgress?: string): Promise<void> {
    await this.dispatch('start', { id, lastProgress })
    await this.loadTodos()
  }

  /**
   * 完成待办
   */
  async completeTodo(id: string, lastProgress?: string): Promise<void> {
    await this.dispatch('complete', { id, lastProgress })
    await this.loadTodos()
  }

  /**
   * 切换子任务状态
   */
  async toggleSubtask(todoId: string, subtaskId: string): Promise<void> {
    const todo = this.todos.find(t => t.id === todoId)
    if (!todo || !todo.subtasks) {
      throw new Error(`待办或子任务不存在`)
    }

    const subtask = todo.subtasks.find(st => st.id === subtaskId)
    if (!subtask) {
      throw new Error(`子任务不存在`)
    }

    // 更新子任务状态
    const updatedSubtasks = todo.subtasks.map(st =>
      st.id === subtaskId ? { ...st, completed: !st.completed } : st
    )

    await this.updateTodo(todoId, { subtasks: updatedSubtasks })
  }

  /**
   * 订阅变化
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 通知监听器
   */
  private notifyListeners(): void {
    this.listeners.forEach(listener => {
      try {
        listener()
      } catch (error) {
        log.error('监听器执行出错:', error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      total: this.todos.length,
      pending: this.todos.filter(t => t.status === 'pending').length,
      inProgress: this.todos.filter(t => t.status === 'in_progress').length,
      completed: this.todos.filter(t => t.status === 'completed').length,
    }
  }

  /**
   * 获取工作区分布（cap.todo breakdown → {workspaceName: count}）
   */
  async getWorkspaceBreakdown(): Promise<Record<string, number>> {
    const result = await this.dispatch('breakdown', {})
    return (result.stats as Record<string, number>) || {}
  }
}

// 创建单例实例
export const simpleTodoService = new SimpleTodoService()
