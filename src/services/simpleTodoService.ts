/**
 * 简化的待办服务
 *
 * 直接读写当前工作区的 .polaris/todos.json 文件
 * 不使用 localStorage,不使用全局状态
 */

import { invoke } from '@tauri-apps/api/core'
import type { TodoItem, TodoCreateParams, TodoUpdateParams } from '@/types'
import { createLogger } from '../utils/logger'

const log = createLogger('SimpleTodoService')

const TODO_FILE = '.polaris/todos.json'

/**
 * 简化的待办服务
 */
export class SimpleTodoService {
  private workspacePath: string | null = null
  private todos: TodoItem[] = []
  private listeners: Set<() => void> = new Set()

  constructor() {
    // 初始化为空,通过 setWorkspace 设置工作区
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
    await this.loadFromFile()
    return this.todos.length
  }

  /**
   * 从文件加载待办
   */
  private async loadFromFile(): Promise<void> {
    if (!this.workspacePath) {
      this.todos = []
      return
    }

    try {
      const filePath = `${this.workspacePath}/${TODO_FILE}`
      const content = await invoke('read_file_absolute', { path: filePath })

      const data = JSON.parse(content as string)
      // 确保 data 是对象且 todos 是数组类型，防止文件内容异常
      this.todos = (data && typeof data === 'object' && Array.isArray(data.todos))
        ? data.todos
        : []
    } catch (error) {
      // 文件不存在或读取失败,初始化为空
      console.log('[SimpleTodoService] 文件不存在或读取失败,初始化为空:', error)
      this.todos = []
      // 自动创建文件
      await this.saveToFile()
    }
  }

  /**
   * 保存到文件
   */
  private async saveToFile(): Promise<void> {
    if (!this.workspacePath) {
      log.warn('未设置工作区,无法保存')
      return
    }

    try {
      const filePath = `${this.workspacePath}/${TODO_FILE}`
      const data = {
        version: '1.0.0',
        updatedAt: new Date().toISOString(),
        todos: this.todos,
      }

      await invoke('write_file_absolute', {
        path: filePath,
        content: JSON.stringify(data, null, 2),
      })

      log.debug(`已保存 ${this.todos.length} 个待办到 ${filePath}`)
    } catch (error) {
      log.error('保存失败:', error instanceof Error ? error : new Error(String(error)))
      throw error
    }
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
  async createTodo(params: TodoCreateParams): Promise<TodoItem> {
    const newTodo: TodoItem = {
      id: crypto.randomUUID(),
      content: params.content,
      description: params.description,
      status: 'pending',
      priority: params.priority || 'normal',
      tags: params.tags,
      relatedFiles: params.relatedFiles,
      subtasks: params.subtasks?.map(st => ({
        id: crypto.randomUUID(),
        title: st.title,
        completed: false,
        createdAt: new Date().toISOString(),
      })) || [],
      dueDate: params.dueDate,
      estimatedHours: params.estimatedHours,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    this.todos.push(newTodo)
    await this.saveToFile()
    this.notifyListeners()

    return newTodo
  }

  /**
   * 更新待办
   */
  async updateTodo(id: string, updates: TodoUpdateParams): Promise<void> {
    const index = this.todos.findIndex(t => t.id === id)
    if (index === -1) {
      throw new Error(`待办不存在: ${id}`)
    }

    const original = this.todos[index]

    // 安全合并更新
    this.todos[index] = {
      ...original,
      ...updates,
      // 保护 content 不被清空
      content: updates.content && updates.content.trim() !== '' ? updates.content : original.content,
      updatedAt: new Date().toISOString(),
    }

    // 如果状态变为 completed,记录完成时间
    if (updates.status === 'completed' && original.status !== 'completed') {
      this.todos[index].completedAt = new Date().toISOString()
    }

    await this.saveToFile()
    this.notifyListeners()
  }

  /**
   * 删除待办
   */
  async deleteTodo(id: string): Promise<void> {
    const index = this.todos.findIndex(t => t.id === id)
    if (index === -1) {
      throw new Error(`待办不存在: ${id}`)
    }

    this.todos.splice(index, 1)
    await this.saveToFile()
    this.notifyListeners()
  }

  /**
   * 切换子任务状态
   */
  async toggleSubtask(todoId: string, subtaskId: string): Promise<void> {
    const todo = this.todos.find(t => t.id === todoId)
    if (!todo) {
      throw new Error(`待办不存在: ${todoId}`)
    }

    const subtask = todo.subtasks?.find(st => st.id === subtaskId)
    if (!subtask) {
      throw new Error(`子任务不存在: ${subtaskId}`)
    }

    subtask.completed = !subtask.completed
    await this.saveToFile()
    this.notifyListeners()
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
}

// 创建单例实例
export const simpleTodoService = new SimpleTodoService()
