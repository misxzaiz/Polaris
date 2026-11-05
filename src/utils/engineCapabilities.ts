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
  'simple-ai': ['agent', 'model', 'effort', 'profile'],
  'open-code': ['model', 'profile'],
}

/**
 * 根据后端引擎元数据推导选择器列表。
 *
 * 优先级：引擎声明的 sessionConfig.selectors > 能力标志推导 > 静态兜底。
 * 引擎声明优先，使插件引擎能精确控制展示哪些选择器（而非依赖能力标志的
 * 间接映射——如 effort 绑 interrupt、permission 绑 stdinInput 是 claude 的
 * 语义，不适用于所有引擎）。
 */
function deriveSelectorsFromCapabilities(engineId: string): SelectorType[] {
  const meta = useEngineMetadataStore.getState().getEngine(engineId)
  if (!meta) {
    return FALLBACK_ENGINE_SELECTOR_CAPABILITIES[engineId] ?? FALLBACK_ENGINE_SELECTOR_CAPABILITIES['claude-code']
  }

  // 引擎声明优先：manifest sessionConfig.selectors 直接指定展示哪些选择器
  if (meta.sessionConfig?.selectors && meta.sessionConfig.selectors.length > 0) {
    return meta.sessionConfig.selectors as SelectorType[]
  }

  // 兜底：按能力标志推导（与既有行为一致，向后兼容）
  const caps = meta.capabilities
  const selectors: SelectorType[] = ['profile'] // profile 始终可用
  if (caps.tools) selectors.push('agent')
  selectors.push('model') // model 始终可用
  if (caps.interrupt) selectors.push('effort')
  if (caps.stdinInput) selectors.push('permission')
  return selectors
}

/**
 * 获取引擎声明的 effort 选项（无声明返回 null，调用方降级到全局 EFFORT_OPTIONS）
 */
export function getEngineEffortOptions(engineId: string | null | undefined): { value: string; label: string; description?: string }[] | null {
  const id = normalizeEngineId(engineId)
  const meta = useEngineMetadataStore.getState().getEngine(id)
  return meta?.sessionConfig?.effortOptions ?? null
}

/**
 * 获取引擎声明的 permission 选项（无声明返回 null，调用方降级到全局 PERMISSION_MODE_OPTIONS）
 */
export function getEnginePermissionOptions(engineId: string | null | undefined): { value: string; label: string; description?: string }[] | null {
  const id = normalizeEngineId(engineId)
  const meta = useEngineMetadataStore.getState().getEngine(id)
  return meta?.sessionConfig?.permissionOptions ?? null
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