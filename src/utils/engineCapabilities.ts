/**
 * 引擎 × 会话配置选择器 能力矩阵
 *
 * 单一事实源：声明每个引擎实际「会被后端消费」的配置选择器。
 * UI（ChatStatusBar / SessionConfigSelector）据此裁剪展示，避免向用户展示
 * 对当前引擎无效、甚至会导致后端报错的选择器。
 *
 * 能力矩阵从后端引擎元数据动态获取，新增引擎时只需在后端注册，
 * 并在 EngineCapabilities 中声明能力，前端自动识别。
 */

import { normalizeEngineId } from './engineDisplay'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'

/** 会话配置选择器类型（与 SessionConfigSelector / ChatStatusBar 保持一致） */
export type SelectorType = 'agent' | 'model' | 'effort' | 'permission' | 'profile'

/**
 * 引擎 → 可展示的选择器列表（静态兜底，元数据加载后使用动态数据）。
 */
const FALLBACK_ENGINE_SELECTOR_CAPABILITIES: Record<string, SelectorType[]> = {
  'claude-code': ['agent', 'model', 'effort', 'permission', 'profile'],
  codex: ['model', 'permission', 'profile'],
  'simple-ai': ['agent', 'model', 'profile'],
  pi: ['model', 'effort', 'profile'],
}

/**
 * 根据后端引擎元数据的能力标志动态推导选择器列表。
 */
function deriveSelectorsFromCapabilities(engineId: string): SelectorType[] {
  const meta = useEngineMetadataStore.getState().getEngine(engineId)
  if (!meta) {
    return FALLBACK_ENGINE_SELECTOR_CAPABILITIES[engineId] ?? FALLBACK_ENGINE_SELECTOR_CAPABILITIES['claude-code']
  }
  const caps = meta.capabilities
  const selectors: SelectorType[] = ['profile'] // profile 始终可用
  if (caps.tools) selectors.push('agent')
  selectors.push('model') // model 始终可用
  if (caps.interrupt) selectors.push('effort')
  if (caps.stdinInput) selectors.push('permission')
  return selectors
}

/**
 * 获取指定引擎可展示的选择器列表（未知引擎降级为 claude-code）
 */
export function getEngineSelectors(engineId?: string | null): SelectorType[] {
  const id = normalizeEngineId(engineId)
  return deriveSelectorsFromCapabilities(id)
}

/**
 * 判断某选择器是否适用于指定引擎
 */
export function isSelectorSupported(engineId: string | null | undefined, type: SelectorType): boolean {
  return getEngineSelectors(engineId).includes(type)
}