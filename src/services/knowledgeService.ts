/**
 * 知识服务 - 统一的项目上下文增强接口
 *
 * 设计原则：
 * - 所有知识注入入口统一调用 enrichPrompt()
 * - 消除硬编码的模块 ID 和文件路径映射
 * - 支持多种数据源实现（本地文件 / MCP 协议）
 */

import { createLogger } from '../utils/logger'
import { readFile } from './tauri/fileService'

const log = createLogger('KnowledgeService')

// ─── Types ─────────────────────────────────────────────────────

/** 模块索引项 */
export interface ModuleIndexEntry {
  id: string
  name: string
  file: string
  dependencies: string[]
  dependents: string[]
  complexity: string
  changeFrequency: string
}

/** 模块索引 */
export interface ModuleIndex {
  version: string
  modules: ModuleIndexEntry[]
}

/** 知识增强选项 */
export interface EnrichOptions {
  /** 是否自动注入全局架构概览（首次消息时） */
  includeOverview?: boolean
  /** 模块文档粒度：L1(摘要) / L2(结构) / L3(完整) */
  detailLevel?: 'L1' | 'L2' | 'L3'
  /** 最大 token 预算（预留，暂未实现） */
  maxTokens?: number
}

/** 知识服务接口 */
export interface IKnowledgeService {
  /** 加载工作区的知识索引（应用启动时调用一次） */
  loadIndex(workspacePath: string): Promise<void>

  /** 检测消息中的 @module 引用，返回增强后的 prompt */
  enrichPrompt(
    content: string,
    basePrompt: string,
    options?: EnrichOptions
  ): Promise<string>

  /** 搜索模块（供 UI 补全等使用） */
  searchModules(query: string): ModuleIndexEntry[]

  /** 获取所有模块 ID（供 @ 补全使用） */
  getModuleIds(): string[]

  /** 获取模块索引（完整数据） */
  getIndex(): ModuleIndex | null
}

// ─── Constants ─────────────────────────────────────────────────

/** 知识目录相对路径（集中管理，改一处生效全局） */
export const KNOWLEDGE_DIR = '.polaris/knowledge'
export const MODULES_SUBDIR = 'modules'
export const INDEX_FILE = 'index.json'

/** @module 引用匹配模式 */
const MODULE_REF_PATTERN = /@([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?=\s|$|[,，。.!?！？])/g

// ─── LocalFileKnowledgeService ──────────────────────────────────

/**
 * 本地文件知识服务实现
 * 直接读取 .polaris/knowledge/ 目录下的文件
 */
export class LocalFileKnowledgeService implements IKnowledgeService {
  private index: ModuleIndex | null = null
  private workspacePath: string | null = null
  private moduleDocsCache: Map<string, string> = new Map()

  async loadIndex(workspacePath: string): Promise<void> {
    this.workspacePath = workspacePath
    this.moduleDocsCache.clear()

    const indexPath = `${workspacePath}/${KNOWLEDGE_DIR}/${INDEX_FILE}`
    try {
      const content = await readFile(indexPath)
      this.index = JSON.parse(content) as ModuleIndex
      log.info(`知识索引已加载: ${this.index?.modules.length ?? 0} 个模块`)
    } catch (err) {
      log.warn('无法加载知识索引', { path: indexPath, error: String(err) })
      this.index = null
    }
  }

  async enrichPrompt(
    content: string,
    basePrompt: string,
    options?: EnrichOptions
  ): Promise<string> {
    const moduleRefs = this.extractModuleReferences(content)
    if (moduleRefs.length === 0) {
      return basePrompt
    }

    const docs = await this.loadModuleDocuments(moduleRefs)
    if (docs.size === 0) {
      return basePrompt
    }

    const lines: string[] = [basePrompt]
    lines.push('')
    lines.push('## 项目模块知识')
    lines.push('')

    for (const [_moduleId, doc] of docs) {
      lines.push(doc)
      lines.push('')
    }

    // 可选：注入架构概览
    if (options?.includeOverview && this.index) {
      lines.push('## 项目架构概览')
      lines.push('')
      lines.push(`项目共 ${this.index.modules.length} 个模块：`)
      for (const m of this.index.modules) {
        lines.push(`- ${m.name} (${m.id})`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  searchModules(query: string): ModuleIndexEntry[] {
    if (!this.index) return []

    const queryLower = query.toLowerCase()
    return this.index.modules.filter(m =>
      m.id.toLowerCase().includes(queryLower) ||
      m.name.toLowerCase().includes(queryLower)
    )
  }

  getModuleIds(): string[] {
    return this.index?.modules.map(m => m.id) ?? []
  }

  getIndex(): ModuleIndex | null {
    return this.index
  }

  // ─── Private ───────────────────────────────────────────────

  private extractModuleReferences(content: string): string[] {
    const moduleIds = new Set(this.getModuleIds())
    if (moduleIds.size === 0) return []

    const refs: string[] = []
    MODULE_REF_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = MODULE_REF_PATTERN.exec(content)) !== null) {
      const candidate = match[1]
      if (moduleIds.has(candidate)) {
        refs.push(candidate)
      }
    }
    return [...new Set(refs)] // 去重
  }

  private async loadModuleDocuments(moduleIds: string[]): Promise<Map<string, string>> {
    const docs = new Map<string, string>()

    if (!this.workspacePath || !this.index) return docs

    for (const moduleId of moduleIds) {
      // 先查缓存
      if (this.moduleDocsCache.has(moduleId)) {
        docs.set(moduleId, this.moduleDocsCache.get(moduleId)!)
        continue
      }

      // 从索引找文件名
      const entry = this.index.modules.find(m => m.id === moduleId)
      if (!entry) continue

      try {
        const filePath = `${this.workspacePath}/${KNOWLEDGE_DIR}/${MODULES_SUBDIR}/${entry.file}`
        const content = await readFile(filePath)
        if (content) {
          this.moduleDocsCache.set(moduleId, content)
          docs.set(moduleId, content)
        }
      } catch (err) {
        log.warn(`无法读取模块文档: ${moduleId}`, { error: String(err) })
      }
    }

    return docs
  }
}

// ─── Singleton ─────────────────────────────────────────────────

let instance: IKnowledgeService | null = null

/**
 * 获取知识服务单例
 */
export function getKnowledgeService(): IKnowledgeService {
  if (!instance) {
    instance = new LocalFileKnowledgeService()
  }
  return instance
}

/**
 * 设置知识服务实例（用于测试或切换实现）
 */
export function setKnowledgeService(service: IKnowledgeService): void {
  instance = service
}
