/**
 * 需求队列服务
 *
 * 直接读写工作区的 .polaris/requirements/requirements.json 文件
 * 模式与 SimpleTodoService 一致：工作区隔离、监听器通知、文件持久化
 */

import { invoke } from '@tauri-apps/api/core'
import type {
  Requirement,
  RequirementCreateParams,
  RequirementUpdateParams,
  RequirementFilter,
  RequirementFileData,
  RequirementStats,
} from '@/types'
import { createDefaultRequirement, computeRequirementStats, sanitizeRequirement } from '@/types/requirement'
import { createLogger } from '../utils/logger'

const log = createLogger('RequirementService')

const REQUIREMENT_DIR = '.polaris/requirements'
const REQUIREMENT_FILE = `${REQUIREMENT_DIR}/requirements.json`
const PROTOTYPE_DIR = `${REQUIREMENT_DIR}/prototypes`
const DATA_VERSION = '1.0.0'

/**
 * 需求队列服务
 */
export class RequirementService {
  private workspacePath: string | null = null
  private requirements: Requirement[] = []
  private listeners: Set<() => void> = new Set()

  /**
   * 设置当前工作区并加载数据
   */
  async setWorkspace(workspacePath: string, forceReload: boolean = false): Promise<number> {
    if (!forceReload && this.workspacePath === workspacePath) {
      return this.requirements.length
    }

    this.workspacePath = workspacePath
    await this.loadFromFile()
    return this.requirements.length
  }

  /**
   * 获取当前工作区路径
   */
  getCurrentWorkspacePath(): string | null {
    return this.workspacePath
  }

  /**
   * 从文件加载需求
   */
  private async loadFromFile(): Promise<void> {
    if (!this.workspacePath) {
      this.requirements = []
      return
    }

    try {
      const filePath = `${this.workspacePath}/${REQUIREMENT_FILE}`
      const content = await invoke<string>('read_file_absolute', { path: filePath })
      const data: RequirementFileData = JSON.parse(content)

      this.requirements = (data && typeof data === 'object' && Array.isArray(data.requirements))
        ? data.requirements.map(sanitizeRequirement).filter((r): r is Requirement => r !== null)
        : []
    } catch (e) {
      if (e instanceof SyntaxError) {
        // JSON 解析失败 — 文件内容损坏
        log.error('需求文件 JSON 格式错误:', e)
        throw new Error(`需求文件格式错误: ${(e as SyntaxError).message}`)
      }
      // 文件不存在或读取失败（如权限问题），初始化为空
      // 不写入文件 — 避免覆盖损坏的 JSON 或触发权限错误
      log.debug('需求文件不存在或读取失败，初始化为空')
      this.requirements = []
    }
  }

  /**
   * 保存到文件
   */
  private async saveToFile(): Promise<void> {
    if (!this.workspacePath) {
      log.warn('未设置工作区，无法保存')
      return
    }

    try {
      const filePath = `${this.workspacePath}/${REQUIREMENT_FILE}`
      const data: RequirementFileData = {
        version: DATA_VERSION,
        updatedAt: new Date().toISOString(),
        requirements: this.requirements,
      }

      await invoke('write_file_absolute', {
        path: filePath,
        content: JSON.stringify(data, null, 2),
      })

      log.debug(`已保存 ${this.requirements.length} 条需求到 ${filePath}`)
    } catch (error) {
      log.error('保存需求失败:', error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  /**
   * 获取所有需求
   */
  getAllRequirements(): Requirement[] {
    return [...this.requirements]
  }

  /**
   * 查询需求
   */
  queryRequirements(filter: RequirementFilter): Requirement[] {
    let result = [...this.requirements]

    if (filter.status && filter.status !== 'all') {
      result = result.filter(r => r.status === filter.status)
    }

    if (filter.priority) {
      result = result.filter(r => r.priority === filter.priority)
    }

    if (filter.source && filter.source !== 'all') {
      result = result.filter(r => r.generatedBy === filter.source)
    }

    if (filter.hasPrototype !== undefined) {
      result = result.filter(r => r.hasPrototype === filter.hasPrototype)
    }

    if (filter.tags && filter.tags.length > 0) {
      result = result.filter(r =>
        filter.tags!.some(tag => r.tags.includes(tag))
      )
    }

    if (filter.search) {
      const keyword = filter.search.toLowerCase()
      result = result.filter(r =>
        r.title.toLowerCase().includes(keyword) ||
        r.description.toLowerCase().includes(keyword)
      )
    }

    // 按更新时间倒序
    result.sort((a, b) => b.updatedAt - a.updatedAt)

    // 分页
    if (filter.offset) {
      result = result.slice(filter.offset)
    }
    if (filter.limit) {
      result = result.slice(0, filter.limit)
    }

    return result
  }

  /**
   * 根据 ID 获取需求
   */
  getRequirementById(id: string): Requirement | undefined {
    return this.requirements.find(r => r.id === id)
  }

  /**
   * 创建需求
   */
  async createRequirement(params: RequirementCreateParams): Promise<Requirement> {
    const newReq = createDefaultRequirement(params)

    this.requirements.push(newReq)
    await this.saveToFile()
    this.notifyListeners()

    log.info(`创建需求: ${newReq.id} - ${newReq.title}`)
    return newReq
  }

  /**
   * 更新需求
   */
  async updateRequirement(id: string, updates: RequirementUpdateParams): Promise<void> {
    const index = this.requirements.findIndex(r => r.id === id)
    if (index === -1) {
      throw new Error(`需求不存在: ${id}`)
    }

    const original = this.requirements[index]
    this.requirements[index] = {
      ...original,
      ...updates,
      updatedAt: Date.now(),
    }

    // 状态转换：记录审核时间
    if ((updates.status === 'approved' || updates.status === 'rejected') &&
        (original.status === 'pending' || original.status === 'draft')) {
      this.requirements[index].reviewedAt = Date.now()
    }

    // 状态转换：记录执行开始时间
    if (updates.status === 'executing' && original.status !== 'executing') {
      this.requirements[index].executedAt = Date.now()
    }

    // 状态转换：记录完成时间
    if (updates.status === 'completed' && original.status !== 'completed') {
      this.requirements[index].completedAt = Date.now()
    }

    await this.saveToFile()
    this.notifyListeners()

    log.info(`更新需求: ${id}, 状态 ${original.status} -> ${updates.status || original.status}`)
  }

  /**
   * 删除需求
   */
  async deleteRequirement(id: string): Promise<void> {
    const index = this.requirements.findIndex(r => r.id === id)
    if (index === -1) {
      throw new Error(`需求不存在: ${id}`)
    }

    this.requirements.splice(index, 1)
    await this.saveToFile()
    this.notifyListeners()

    log.info(`删除需求: ${id}`)
  }

  /**
   * 批量删除需求
   */
  async batchDeleteRequirements(ids: string[]): Promise<void> {
    const idSet = new Set(ids)
    const before = this.requirements.length
    this.requirements = this.requirements.filter(r => !idSet.has(r.id))
    const deleted = before - this.requirements.length

    if (deleted > 0) {
      await this.saveToFile()
      this.notifyListeners()
      log.info(`批量删除 ${deleted} 条需求`)
    }
  }

  /**
   * 获取待执行需求（按优先级和调度时间排序）
   */
  getExecutableRequirements(): Requirement[] {
    const now = Date.now()
    return this.requirements
      .filter(r => {
        // 只能执行已批准的
        if (r.status !== 'approved') return false
        // 如果设置了定时执行，检查是否到达执行时间
        if (r.executeConfig?.scheduledAt && r.executeConfig.scheduledAt > now) {
          return false
        }
        return true
      })
      .sort((a, b) => {
        // 按优先级排序
        const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 }
        const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority]
        if (priorityDiff !== 0) return priorityDiff
        // 同优先级按调度时间排序
        return (a.executeConfig?.scheduledAt || 0) - (b.executeConfig?.scheduledAt || 0)
      })
  }

  /**
   * 保存原型 HTML 文件
   */
  async savePrototype(id: string, html: string): Promise<string> {
    if (!this.workspacePath) {
      throw new Error('未设置工作区')
    }

    const prototypePath = `${PROTOTYPE_DIR}/${id}.html`
    const fullPath = `${this.workspacePath}/${prototypePath}`

    await invoke('write_file_absolute', {
      path: fullPath,
      content: html,
    })

    // 更新需求中的原型路径
    await this.updateRequirement(id, {
      prototypePath,
      hasPrototype: true,
    })

    log.info(`保存原型: ${prototypePath}`)
    return prototypePath
  }

  /**
   * 读取原型 HTML 文件
   */
  async readPrototype(prototypePath: string): Promise<string> {
    if (!this.workspacePath) {
      throw new Error('未设置工作区')
    }

    const fullPath = `${this.workspacePath}/${prototypePath}`
    return await invoke<string>('read_file_absolute', { path: fullPath })
  }

  /**
   * 获取原型文件的绝对路径
   */
  getPrototypeAbsolutePath(prototypePath: string): string | null {
    if (!this.workspacePath) {
      return null
    }
    return `${this.workspacePath}/${prototypePath}`
  }

  /**
   * 获取统计信息
   */
  getStats(): RequirementStats {
    return computeRequirementStats(this.requirements)
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
}

// 创建单例实例
export const requirementService = new RequirementService()
