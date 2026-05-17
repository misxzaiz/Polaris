/**
 * KnowledgePanel 共享常量
 *
 * 从 KnowledgeHealthDashboard 提取，供 ModuleDetailDialog 等组件复用
 */

/** 置信度等级 */
export type ConfidenceLevel = 'green' | 'yellow' | 'orange' | 'red' | 'black'

/** 置信度视觉配置 */
export const CONFIDENCE_CONFIG: Record<ConfidenceLevel, {
  labelKey: string
  color: string
  bgColor: string
}> = {
  green: { labelKey: 'confidence.green', color: 'text-green-500', bgColor: 'bg-green-500' },
  yellow: { labelKey: 'confidence.yellow', color: 'text-yellow-500', bgColor: 'bg-yellow-500' },
  orange: { labelKey: 'confidence.orange', color: 'text-orange-500', bgColor: 'bg-orange-500' },
  red: { labelKey: 'confidence.red', color: 'text-red-500', bgColor: 'bg-red-500' },
  black: { labelKey: 'confidence.black', color: 'text-gray-500', bgColor: 'bg-gray-500' },
}

/** 复杂度颜色映射 */
export const COMPLEXITY_COLORS: Record<string, string> = {
  low: 'text-green-500',
  medium: 'text-amber-500',
  high: 'text-red-500',
}

/** 变更频率颜色映射 */
export const FREQUENCY_COLORS: Record<string, string> = {
  low: 'text-green-500',
  medium: 'text-amber-500',
  high: 'text-red-500',
}
