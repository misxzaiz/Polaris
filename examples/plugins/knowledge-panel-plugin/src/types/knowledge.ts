/**
 * 知识库类型定义
 *
 * 与 Rust 侧 models/knowledge.rs 和 .polaris/knowledge/index.v2.json 对齐。
 * 前端所有知识库相关组件、服务、Store 统一从此文件导入类型。
 */

// =============================================================================
// Enums (union types)
// =============================================================================

export type Complexity = 'low' | 'medium' | 'high'
export type ChangeFrequency = 'low' | 'medium' | 'high'
export type Confidence = 'green' | 'yellow' | 'orange' | 'red' | 'black'
export type Severity = 'low' | 'medium' | 'high'

// =============================================================================
// Assertion
// =============================================================================

export interface AssertionAnchor {
  file?: string
  symbol?: string
  line?: number
}

export interface AssertionExpect {
  equals?: number | string
  regex?: string
  type?: string
  value?: string
  range?: { min: number; max: number }
}

export interface Assertion {
  id: string
  claim: string
  anchor?: AssertionAnchor
  expect?: AssertionExpect
  confidence: Confidence
  trap?: boolean
  source: string
}

// =============================================================================
// Trap
// =============================================================================

export interface Trap {
  id: string
  description: string
  severity?: Severity
  source?: string
  files?: string[]
  location?: string
}

// =============================================================================
// Module Scope
// =============================================================================

export interface ModuleScope {
  include: string[]
  exclude?: string[]
}

// =============================================================================
// Domain
// =============================================================================

export interface DomainDefinition {
  id: string
  name: string
  description?: string
  modules: string[]
}

// =============================================================================
// Workspace Meta
// =============================================================================

export interface WorkspaceMeta {
  rootPath: string
  language: string[]
  framework: string[]
}

// =============================================================================
// Module (v2 entry — matches Rust KnowledgeModule)
// =============================================================================

export interface KnowledgeModule {
  id: string
  name: string
  domain?: string
  scope?: ModuleScope
  dependencies: string[]
  dependents: string[]
  /** Markdown 文档文件名 (不含 .md 后缀) */
  documentFile?: string
  complexity: Complexity
  changeFrequency: ChangeFrequency
  assertions: Assertion[]
  traps: Trap[]
}

/**
 * @deprecated 使用 KnowledgeModule 代替。为向后兼容保留。
 */
export type ModuleIndexEntry = KnowledgeModule & {
  /** @deprecated v1 字段，v2 使用 documentFile */
  file?: string
}

// =============================================================================
// Module Detail (get_module response)
// =============================================================================

export interface ModuleDetail {
  id: string
  name: string
  domain?: string
  scope?: ModuleScope
  dependencies: string[]
  dependents: string[]
  documentFile?: string
  complexity: Complexity
  changeFrequency: ChangeFrequency
  assertions: Assertion[]
  traps: Trap[]
  /** Markdown 文档内容 */
  document?: string
}

// =============================================================================
// Module Index (v2 — matches Rust KnowledgeIndex)
// =============================================================================

export interface KnowledgeIndex {
  version: string
  schemaVersion?: string
  generatedAt?: string
  workspace?: WorkspaceMeta
  domains: DomainDefinition[]
  modules: KnowledgeModule[]
  globalConventions?: unknown[]
}

// =============================================================================
// Stale Module
// =============================================================================

export interface StaleModule {
  id: string
  name: string
  staleSince: string
  changedFiles: string[]
}

// =============================================================================
// Knowledge Status
// =============================================================================

export type KnowledgeStatus = 'loaded' | 'not_initialized' | 'error'

export interface KnowledgeLoadResult {
  status: KnowledgeStatus
  error?: string
}
