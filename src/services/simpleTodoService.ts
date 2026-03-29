/**
 * 统一待办服务
 *
 * 调用后端 Tauri 命令，支持全局和工作区双模式
 */

import { invoke } from '@tauri-apps/api/core'
import type { TodoItem, TodoPriority, TodoStatus } from '@/types'
import { createLogger } from '../utils/logger'

const log = createLogger('SimpleTodoService')

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
      console.log('[SimpleTodoService] 工作区未切换，跳过重新加载')
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
   * 从后端加载待办
   */
  private async loadTodos(): Promise<void> {
    try {
      this.todos = await invoke('list_todos', {
        params: {
          scope: this.scope,
          workspacePath: this.workspacePath,
        }
      })
      this.notifyListeners()
    } catch (error) {
      console.error('[SimpleTodoService] 加载失败:', error)
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
    isGlobal?: boolean
  }): Promise<TodoItem> {
    const todo = await invoke<TodoItem>('create_todo', {
      params: {
        content: params.content,
        description: params.description,
        priority: params.priority,
        tags: params.tags,
        relatedFiles: params.relatedFiles,
        dueDate: params.dueDate,
        estimatedHours: params.estimatedHours,
        subtasks: params.subtasks,
        isGlobal: params.isGlobal || false,
        workspacePath: this.workspacePath,
      }
    })

    await this.loadTodos()
    return todo
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
    await invoke('update_todo', {
      params: {
        id,
        ...updates,
        workspacePath: this.workspacePath,
      }
    })

    await this.loadTodos()
  }

  /**
   * 删除待办
   */
  async deleteTodo(id: string): Promise<void> {
    await invoke('delete_todo', {
      params: {
        id,
        workspacePath: this.workspacePath,
      }
    })

    await this.loadTodos()
  }

  /**
   * 开始待办
   */
  async startTodo(id: string, lastProgress?: string): Promise<void> {
    await invoke('start_todo', {
      params: {
        id,
        lastProgress,
        workspacePath: this.workspacePath,
      }
    })

    await this.loadTodos()
  }

  /**
   * 完成待办
   */
  async completeTodo(id: string, lastProgress?: string): Promise<void> {
    await invoke('complete_todo', {
      params: {
        id,
        lastProgress,
        workspacePath: this.workspacePath,
      }
    })

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
   * 获取工作区分布
   */
  async getWorkspaceBreakdown(): Promise<Record<string, number>> {
    return await invoke('get_todo_workspace_breakdown', {
      params: {
        workspacePath: this.workspacePath,
      }
    })
  }
}

// 创建单例实例
export const simpleTodoService = new SimpleTodoService()
