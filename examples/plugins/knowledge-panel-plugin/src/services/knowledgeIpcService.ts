/**
 * Knowledge IPC Service
 *
 * Tauri invoke wrappers for knowledge CRUD commands.
 * Stateless function pattern — one function per Tauri command.
 */

import { invoke } from '../runtime'
import type {
  KnowledgeModule,
  ModuleDetail,
  DomainDefinition,
  Assertion,
  AssertionAnchor,
  AssertionExpect,
  Trap,
  KnowledgeIndex,
} from '../types/knowledge'

// =============================================================================
// Helpers
// =============================================================================

function params(workspacePath: string | null | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    params: {
      workspacePath: workspacePath || null,
      ...extra,
    },
  }
}

// Overload for typed data objects (interfaces don't satisfy index signatures)
function paramsWithData(workspacePath: string | null | undefined, data: object): Record<string, unknown> {
  return {
    params: {
      workspacePath: workspacePath || null,
      ...data,
    },
  }
}

// =============================================================================
// Init
// =============================================================================

export async function knowledgeInit(workspacePath: string): Promise<KnowledgeIndex> {
  return invoke<KnowledgeIndex>('knowledge_init', params(workspacePath))
}

// =============================================================================
// Read
// =============================================================================

export async function knowledgeListModules(
  workspacePath: string,
  options?: { domain?: string; query?: string },
): Promise<KnowledgeModule[]> {
  return invoke<KnowledgeModule[]>(
    'knowledge_list_modules',
    params(workspacePath, options ?? {}),
  )
}

export async function knowledgeGetModule(
  workspacePath: string,
  id: string,
): Promise<ModuleDetail> {
  return invoke<ModuleDetail>('knowledge_get_module', params(workspacePath, { id }))
}

export async function knowledgeListDomains(
  workspacePath: string,
): Promise<DomainDefinition[]> {
  return invoke<DomainDefinition[]>('knowledge_list_domains', params(workspacePath))
}

// =============================================================================
// Module CRUD
// =============================================================================

export interface CreateModuleData {
  id: string
  name: string
  domain?: string
  scope?: { include: string[]; exclude?: string[] }
  dependencies?: string[]
  complexity?: string
  changeFrequency?: string
}

export async function knowledgeCreateModule(
  workspacePath: string,
  data: CreateModuleData,
): Promise<KnowledgeModule> {
  return invoke<KnowledgeModule>('knowledge_create_module', paramsWithData(workspacePath, data))
}

export interface UpdateModuleData {
  id: string
  name?: string
  domain?: string
  scope?: { include: string[]; exclude?: string[] }
  dependencies?: string[]
  complexity?: string
  changeFrequency?: string
}

export async function knowledgeUpdateModule(
  workspacePath: string,
  data: UpdateModuleData,
): Promise<KnowledgeModule> {
  return invoke<KnowledgeModule>('knowledge_update_module', paramsWithData(workspacePath, data))
}

export async function knowledgeDeleteModule(
  workspacePath: string,
  id: string,
): Promise<void> {
  return invoke<void>('knowledge_delete_module', params(workspacePath, { id }))
}

// =============================================================================
// Module Document
// =============================================================================

export async function knowledgeUpdateModuleDocument(
  workspacePath: string,
  moduleId: string,
  content: string,
): Promise<void> {
  return invoke<void>(
    'knowledge_update_module_document',
    params(workspacePath, { moduleId, content }),
  )
}

// =============================================================================
// Assertion CRUD
// =============================================================================

export async function knowledgeCreateAssertion(
  workspacePath: string,
  moduleId: string,
  assertion: Assertion,
): Promise<Assertion> {
  return invoke<Assertion>(
    'knowledge_create_assertion',
    params(workspacePath, { moduleId, assertion }),
  )
}

export async function knowledgeUpdateAssertion(
  workspacePath: string,
  moduleId: string,
  assertionId: string,
  updates: {
    claim?: string
    anchor?: AssertionAnchor
    expect?: AssertionExpect
    confidence?: string
  },
): Promise<Assertion> {
  return invoke<Assertion>(
    'knowledge_update_assertion',
    params(workspacePath, { moduleId, assertionId, ...updates }),
  )
}

export async function knowledgeDeleteAssertion(
  workspacePath: string,
  moduleId: string,
  assertionId: string,
): Promise<void> {
  return invoke<void>(
    'knowledge_delete_assertion',
    params(workspacePath, { moduleId, assertionId }),
  )
}

// =============================================================================
// Trap CRUD
// =============================================================================

export async function knowledgeCreateTrap(
  workspacePath: string,
  moduleId: string,
  trap: Trap,
): Promise<Trap> {
  return invoke<Trap>(
    'knowledge_create_trap',
    params(workspacePath, { moduleId, trap }),
  )
}

export async function knowledgeUpdateTrap(
  workspacePath: string,
  moduleId: string,
  trapId: string,
  updates: { description?: string; severity?: string },
): Promise<Trap> {
  return invoke<Trap>(
    'knowledge_update_trap',
    params(workspacePath, { moduleId, trapId, ...updates }),
  )
}

export async function knowledgeDeleteTrap(
  workspacePath: string,
  moduleId: string,
  trapId: string,
): Promise<void> {
  return invoke<void>(
    'knowledge_delete_trap',
    params(workspacePath, { moduleId, trapId }),
  )
}
