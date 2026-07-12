/**
 * 需求队列服务
 *
 * 调用后端 Tauri 命令，支持全局单存储架构
 */

import { invoke } from '@/services/transport'
import type {
  Requirement,
  RequirementCreateParams,
  RequirementUpdateParams,
  RequirementFilter,
  RequirementStats,
} from '@/types'
import { computeRequirementStats } from '@/types/requirement'
import { createLogger } from '@/utils/logger'

const log = createLogger('RequirementService')

/** 查询范围类型 */
export type QueryScopeType = 'workspace' | 'all'

/** 默认查询范围：显示所有需求 */
const DEFAULT_SCOPE: QueryScopeType = 'all'

/**
 * 需求队列服务
 */
export class RequirementService {
  private workspacePath: string | null = null
  private scope: QueryScopeType = DEFAULT_SCOPE
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
    // 不重置 scope，保持用户选择的范围
    await this.loadRequirements()
    return this.requirements.length
  }

  /**
   * 获取当前工作区路径
   */
  getCurrentWorkspacePath(): string | null {
    return this.workspacePath
  }

  /**
   * 设置查询范围
   */
  setScope(scope: 'workspace' | 'all'): void {
    if (this.scope !== scope) {
      this.scope = scope
      this.loadRequirements()
    }
  }

  /**
   * 获取当前查询范围
   */
  getScope(): 'workspace' | 'all' {
    return this.scope
  }

  /**
   * 从后端加载需求
   */
  private async loadRequirements(): Promise<void> {
    try {
      this.requirements = await invoke('list_requirements', {
        params: {
          scope: this.scope,
          workspacePath: this.workspacePath,
        }
      })
      this.notifyListeners()
    } catch (error) {
      log.error('加载需求失败:', error instanceof Error ? error : new Error(String(error)))
      this.requirements = []
    }
  }

  /**
   * 刷新需求列表
   */
  async refresh(): Promise<void> {
    await this.loadRequirements()
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
      const tags = filter.tags
      result = result.filter(r =>
        tags.some(tag => r.tags.includes(tag))
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
    const requirement = await invoke<Requirement>('create_requirement', {
      params: {
        title: params.title,
        description: params.description,
        priority: params.priority,
        tags: params.tags,
        hasPrototype: params.hasPrototype,
        generatedBy: params.generatedBy,
        generatorTaskId: params.generatorTaskId,
        workspacePath: this.workspacePath,
      }
    })

    await this.loadRequirements()
    log.info(`创建需求: ${requirement.id} - ${requirement.title}`)
    return requirement
  }

  /**
   * 更新需求
   */
  async updateRequirement(id: string, updates: RequirementUpdateParams): Promise<void> {
    await invoke('update_requirement', {
      params: {
        id,
        ...updates,
        workspacePath: this.workspacePath,
      }
    })

    await this.loadRequirements()
    log.info(`更新需求: ${id}`)
  }

  /**
   * 删除需求
   */
  async deleteRequirement(id: string): Promise<void> {
    await invoke('delete_requirement', {
      params: {
        id,
        workspacePath: this.workspacePath,
      }
    })

    await this.loadRequirements()
    log.info(`删除需求: ${id}`)
  }

  /**
   * 批量删除需求
   */
  async batchDeleteRequirements(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.deleteRequirement(id)
    }
    log.info(`批量删除 ${ids.length} 条需求`)
  }

  /**
   * 保存原型 HTML 文件
   */
  async savePrototype(id: string, html: string): Promise<string> {
    const prototypePath = await invoke<string>('save_requirement_prototype', {
      params: {
        id,
        html,
        workspacePath: this.workspacePath,
      }
    })

    await this.loadRequirements()
    log.info(`保存原型: ${prototypePath}`)
    return prototypePath
  }

  /**
   * 读取原型 HTML 文件
   */
  async readPrototype(prototypePath: string): Promise<string> {
    return await invoke<string>('read_requirement_prototype', {
      params: {
        prototypePath,
        workspacePath: this.workspacePath,
      }
    })
  }

  /**
   * 获取统计信息
   */
  getStats(): RequirementStats {
    return computeRequirementStats(this.requirements)
  }

  /**
   * 获取工作区分布
   */
  async getWorkspaceBreakdown(): Promise<Record<string, number>> {
    return await invoke('get_requirement_workspace_breakdown', {
      params: {
        workspacePath: this.workspacePath,
      }
    })
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
