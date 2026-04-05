/**
 * Engines Registry
 *
 * 导出所有可用的 AI Engine 实现。
 */

// 导出 Claude Code Engine
export * from './claude-code'

// 导出 OpenAI Provider Engine
export * from './openai-provider'

/**
 * 获取所有可用的 Engine IDs
 */
export function getAvailableEngineIds(): string[] {
  return ['claude-code']
}

/**
 * 获取默认 Engine ID
 */
export function getDefaultEngineId(): string {
  return 'claude-code'
}

/**
 * Engine 描述信息
 */
export interface EngineDescriptor {
  id: string
  name: string
  description: string
  available: boolean
}

/**
 * 获取所有 Engine 描述信息
 */
export function getEngineDescriptors(): EngineDescriptor[] {
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      description: 'Anthropic 官方 Claude CLI',
      available: true,
    },
  ]
}
