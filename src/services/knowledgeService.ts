/**
 * 知识服务 - 统一的项目上下文增强接口
 *
 * 设计原则：
 * - 使用 #module-id 语法引用知识模块（避免与 @文件引用 冲突）
 * - 不直接注入完整文档，改为注入"路径提示"
 * - AI 通过 knowledge MCP 的 get_module 工具按需获取详情
 */

import { createLogger } from '../utils/logger'
import { readFile, readDirectory, deleteFile, createDirectory, createFile, pathExists } from './tauri/fileService'

const log = createLogger('KnowledgeService')

// ─── Types ─────────────────────────────────────────────────────

/** 断言定义 */
export interface Assertion {
  id: string
  claim: string
  anchor?: {
    file: string
    symbol?: string
    line?: number
  }
  expect?: {
    equals?: number | string
    regex?: string
    type?: string
    value?: string
  }
  confidence: 'green' | 'yellow' | 'orange' | 'red' | 'black'
  trap?: boolean
  source: string
}

/** 陷阱定义 */
export interface Trap {
  id: string
  description: string
  severity?: 'low' | 'medium' | 'high'
  source?: string
  files?: string[]
  location?: string
}

/** 模块文件范围 (v2) */
export interface ModuleScope {
  include: string[]
  exclude?: string[]
}

/** 领域定义 (v2) */
export interface DomainDefinition {
  id: string
  name: string
  description?: string
  modules: string[]
}

/** 工作区元信息 (v2) */
export interface WorkspaceMeta {
  rootPath: string
  language: string[]
  framework: string[]
}

/** 模块索引项 */
export interface ModuleIndexEntry {
  id: string
  name: string
  /** Markdown 文档文件名 (如 "ai-engine.md") */
  file: string
  /** 所属领域 ID (v2, 如 "ai-conversation") */
  domain?: string
  /** 文件范围模式 (v2) */
  scope?: ModuleScope
  dependencies: string[]
  dependents: string[]
  complexity: string
  changeFrequency: string
  assertions?: Assertion[]
  traps?: Trap[]
}

/** 过期模块信息 */
export interface StaleModule {
  id: string
  name: string
  staleSince: string
  changedFiles: string[]
}

/** 模块索引 */
export interface ModuleIndex {
  version: string
  modules: ModuleIndexEntry[]
  /** 领域定义 (v2) */
  domains?: DomainDefinition[]
  /** 工作区元信息 (v2) */
  workspace?: WorkspaceMeta
  /** 全局约定 (v2) */
  globalConventions?: string[]
}

/** 知识增强选项 */
export interface EnrichOptions {
  /** 是否自动注入全局架构概览（首次消息时） */
  includeOverview?: boolean
  /** 是否注入完整文档（默认 false，仅注入路径提示） */
  includeFullDocs?: boolean
}

/** 知识加载状态 */
export type KnowledgeStatus = 'loaded' | 'not_initialized' | 'error'

/** 知识加载结果 */
export interface KnowledgeLoadResult {
  status: KnowledgeStatus
  error?: string
}

/** 知识服务接口 */
export interface IKnowledgeService {
  /** 加载工作区的知识索引。返回加载状态，区分「未初始化」和「加载失败」 */
  loadIndex(workspacePath: string): Promise<KnowledgeLoadResult>

  /** 初始化知识库（创建目录结构和空索引文件）。不依赖 MCP，直接操作文件系统 */
  initKnowledge(workspacePath: string): Promise<void>

  /** 检测消息中的 #module 引用，返回增强后的 prompt */
  enrichPrompt(
    content: string,
    basePrompt: string,
    options?: EnrichOptions
  ): Promise<string>

  /** 搜索模块（供 UI 补全等使用） */
  searchModules(query: string): ModuleIndexEntry[]

  /** 获取所有模块 ID（供 # 补全使用） */
  getModuleIds(): string[]

  /** 获取模块索引（完整数据） */
  getIndex(): ModuleIndex | null

  /** 获取模块信息（用于路径提示） */
  getModule(id: string): ModuleIndexEntry | undefined

  /** 加载模块 Markdown 文档内容 */
  getModuleDocument(moduleId: string): Promise<string | null>

  /** 获取过期模块列表 */
  getStaleModules(): Promise<StaleModule[]>

  /** 清除模块过期标记 */
  clearStaleMarker(id: string): Promise<boolean>
}

// ─── Constants ─────────────────────────────────────────────────

/** 知识目录相对路径（集中管理，改一处生效全局） */
export const KNOWLEDGE_DIR = '.polaris/knowledge'
export const MODULES_SUBDIR = 'modules'
export const INDEX_FILE = 'index.json'
export const INDEX_V2_FILE = 'index.v2.json'

/** #module 引用匹配模式（使用 # 避免与 @文件引用 冲突） */
/** 匹配 #module-id 格式，支持无连字符的单单词 ID（如 terminal、mcp） */
const MODULE_REF_PATTERN = /#([a-z][a-z0-9-]+)(?=\s|$|[,，。.!?！？])/g

// ─── LocalFileKnowledgeService ──────────────────────────────────

/**
 * 本地文件知识服务实现
 * 直接读取 .polaris/knowledge/ 目录下的文件
 */
export class LocalFileKnowledgeService implements IKnowledgeService {
  private index: ModuleIndex | null = null
  private workspacePath: string | null = null
  private moduleDocsCache: Map<string, string> = new Map()
  private staleModulesCache: StaleModule[] | null = null

  async loadIndex(workspacePath: string): Promise<KnowledgeLoadResult> {
    this.workspacePath = workspacePath
    this.moduleDocsCache.clear()
    this.staleModulesCache = null

    // 优先加载 v2 索引，回退到 v1
    const indexV2Path = `${workspacePath}/${KNOWLEDGE_DIR}/${INDEX_V2_FILE}`
    const indexV1Path = `${workspacePath}/${KNOWLEDGE_DIR}/${INDEX_FILE}`

    // 检查两个索引文件是否都不存在
    const v1Exists = await pathExists(indexV1Path).catch(() => false)
    const v2Exists = await pathExists(indexV2Path).catch(() => false)

    if (!v1Exists && !v2Exists) {
      this.index = null
      log.info('知识索引文件不存在，知识库可能未初始化')
      return { status: 'not_initialized' }
    }

    try {
      const content = await readFile(indexV2Path)
      if (content) {
        const v2Data = JSON.parse(content)
        // 从 v2 格式提取模块信息（含 assertions 和 traps）
        // v2 JSON uses `documentFile` but ModuleIndexEntry expects `file` — normalize
        const modules: ModuleIndexEntry[] = (v2Data.modules ?? []).map(
          (m: Record<string, unknown>) => ({
            ...m,
            file: (m.file as string) || (m.documentFile as string) || `${m.id}.md`,
          })
        )
        this.index = {
          version: v2Data.version,
          modules,
          domains: v2Data.domains,
          workspace: v2Data.workspace,
          globalConventions: v2Data.globalConventions,
        }
        log.info(`知识索引(v2)已加载: ${this.index?.modules.length ?? 0} 个模块`)
        return { status: 'loaded' }
      }
    } catch (err) {
      // v2 文件存在但解析失败，记录警告后回退到 v1
      log.warn('v2 索引加载失败，回退到 v1', { error: String(err) })
    }

    try {
      const content = await readFile(indexV1Path)
      const parsed = JSON.parse(content)
      // 基本校验：modules 字段必须存在且为数组
      if (!parsed || !Array.isArray(parsed.modules)) {
        this.index = null
        const msg = '知识索引格式错误：缺少 modules 字段'
        log.error(msg)
        return { status: 'error', error: msg }
      }
      this.index = parsed as ModuleIndex
      log.info(`知识索引(v1)已加载: ${this.index?.modules.length ?? 0} 个模块`)
      return { status: 'loaded' }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.index = null
      log.error('知识索引加载失败', err instanceof Error ? err : new Error(errorMsg))
      return { status: 'error', error: errorMsg }
    }
  }

  async initKnowledge(workspacePath: string): Promise<void> {
    const knowledgeDir = `${workspacePath}/${KNOWLEDGE_DIR}`
    const modulesDir = `${knowledgeDir}/${MODULES_SUBDIR}`
    const metaDir = `${knowledgeDir}/meta`

    // 1. 创建目录结构
    await createDirectory(modulesDir)
    await createDirectory(metaDir)

    // 2. 创建空 v1 索引（幂等：不覆盖已有文件）
    const indexPath = `${knowledgeDir}/${INDEX_FILE}`
    const indexExists = await pathExists(indexPath).catch(() => false)
    if (!indexExists) {
      const v1Content = JSON.stringify({ version: '1.0', modules: [] }, null, 2)
      await createFile(indexPath, v1Content)
      log.info('已创建空 v1 知识索引')
    }

    // 3. 创建空 v2 索引（幂等）
    const v2Path = `${knowledgeDir}/${INDEX_V2_FILE}`
    const v2Exists = await pathExists(v2Path).catch(() => false)
    if (!v2Exists) {
      const v2Content = JSON.stringify({
        version: '2.0.0',
        schemaVersion: 'assertion-based',
        generatedAt: new Date().toISOString(),
        domains: [],
        modules: [],
        workspace: { rootPath: workspacePath, language: [], framework: [] },
      }, null, 2)
      await createFile(v2Path, v2Content)
      log.info('已创建空 v2 知识索引')
    }

    // 4. 重新加载索引
    await this.loadIndex(workspacePath)
    log.info('知识库初始化完成')
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

    const lines: string[] = [basePrompt]
    lines.push('')
    lines.push('## 项目模块知识')
    lines.push('')

    if (options?.includeFullDocs) {
      // 完整文档模式（不推荐，token 消耗大）
      const docs = await this.loadModuleDocuments(moduleRefs)
      for (const [_moduleId, doc] of docs) {
        lines.push(doc)
        lines.push('')
      }
    } else {
      // 路径提示模式（推荐，AI 自行决定是否获取详情）
      lines.push('以下模块被引用，**必须立即调用 MCP 工具获取完整文档**：')
      lines.push('')

      for (const moduleId of moduleRefs) {
        const entry = this.index?.modules.find(m => m.id === moduleId)
        if (entry) {
          lines.push(`- **${entry.name}** (\`${moduleId}\`)`)
          lines.push('')
        }
      }

      lines.push('## 立即执行')
      lines.push('请在回答问题前，**先调用以下 MCP 工具**获取模块详情：')
      lines.push('')
      lines.push('```json')
      lines.push('{ "tool": "mcp__polaris-knowledge__get_module", "args": { "id": "module-id" } }')
      lines.push('```')
      lines.push('')
      lines.push('**不要基于猜测回答**，必须先获取完整文档后再回答。')
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

  getModule(id: string): ModuleIndexEntry | undefined {
    return this.index?.modules.find(m => m.id === id)
  }

  getIndex(): ModuleIndex | null {
    return this.index
  }

  async getModuleDocument(moduleId: string): Promise<string | null> {
    if (!this.workspacePath || !this.index) return null

    if (this.moduleDocsCache.has(moduleId)) {
      return this.moduleDocsCache.get(moduleId) ?? null
    }

    const entry = this.index.modules.find(m => m.id === moduleId)
    if (!entry) return null

    try {
      const filePath = `${this.workspacePath}/${KNOWLEDGE_DIR}/${MODULES_SUBDIR}/${entry.file}`
      const content = await readFile(filePath)
      if (content) {
        this.moduleDocsCache.set(moduleId, content)
      }
      return content ?? null
    } catch (err) {
      log.warn(`无法读取模块文档: ${moduleId}`, { error: String(err) })
      return null
    }
  }

  async getStaleModules(): Promise<StaleModule[]> {
    if (this.staleModulesCache) return this.staleModulesCache
    if (!this.workspacePath) return []

    const metaDir = `${this.workspacePath}/${KNOWLEDGE_DIR}/meta`
    const staleModules: StaleModule[] = []

    try {
      const entries = await readDirectory(metaDir) as string[]
      for (const entry of entries) {
        if (entry.endsWith('.stale')) {
          const moduleId = entry.replace('.stale', '')
          const moduleName = this.index?.modules.find(m => m.id === moduleId)?.name ?? moduleId

          const content = await readFile(`${metaDir}/${entry}`)
          const [timestamp, filesStr] = content.split('|')
          const changedFiles = filesStr ? filesStr.split(',') : []

          staleModules.push({
            id: moduleId,
            name: moduleName,
            staleSince: timestamp || '',
            changedFiles,
          })
        }
      }
      this.staleModulesCache = staleModules
    } catch (err) {
      log.warn('无法读取过期模块信息', { error: String(err) })
    }

    return staleModules
  }

  async clearStaleMarker(id: string): Promise<boolean> {
    if (!this.workspacePath) return false

    const staleFile = `${this.workspacePath}/${KNOWLEDGE_DIR}/meta/${id}.stale`
    try {
      await deleteFile(staleFile)
      // 清除缓存
      if (this.staleModulesCache) {
        this.staleModulesCache = this.staleModulesCache.filter(m => m.id !== id)
      }
      log.info(`已清除模块 ${id} 的过期标记`)
      return true
    } catch (err) {
      log.warn(`无法清除过期标记: ${id}`, { error: String(err) })
      return false
    }
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
        const cached = this.moduleDocsCache.get(moduleId)
        if (cached) docs.set(moduleId, cached)
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
