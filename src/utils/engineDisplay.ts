/**
 * 引擎显示工具函数
 *
 * 显示名称从后端引擎元数据动态获取，无需硬编码引擎列表。
 * 新增引擎时只需在后端注册到 EngineRegistry，显示名称自动生效。
 *
 * 注意：此模块为纯函数工具，通过 store.getState() 访问元数据，
 * 不依赖 React 组件生命周期。若需响应式数据，请使用 useEngineMetadataStore 钩子。
 */

import type { EngineId } from '@/types'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'

/**
 * 标准化引擎 ID：验证并返回合法引擎 ID，未知引擎降级为 claude-code。
 */
export function normalizeEngineId(engineId?: string | null): EngineId {
  if (!engineId) return 'claude-code'
  const metadatas = useEngineMetadataStore.getState().metadatas
  if (metadatas.length === 0) {
    // 元数据未加载时使用静态降级列表
    const fallback: EngineId[] = ['claude-code', 'codex', 'simple-ai', 'pi']
    return (fallback as string[]).includes(engineId) ? (engineId as EngineId) : 'claude-code'
  }
  return metadatas.some(m => m.id === engineId) ? (engineId as EngineId) : 'claude-code'
}

/**
 * 获取引擎简短显示名称（如 "Claude"、"Codex"、"Simple AI"、"Pi"）
 */
export function getEngineDisplayName(engineId?: string | null): string {
  const id = normalizeEngineId(engineId)
  return useEngineMetadataStore.getState().getEngineDisplayName(id)
}

/**
 * 获取引擎完整显示名称（如 "Claude Code"、"OpenAI Codex"）
 */
export function getEngineFullName(engineId?: string | null): string {
  const id = normalizeEngineId(engineId)
  return useEngineMetadataStore.getState().getEngineFullName(id)
}