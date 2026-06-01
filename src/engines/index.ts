/**
 * Engines Registry
 *
 * 导出所有可用的 AI Engine 实现。
 */

// 导出 Claude Code Engine
export * from './claude-code'

// 导出 Codex Engine
export * from './codex'

// 导出 Agnes Multi-Modal Engine
export { AgnesMultiModalEngine } from './agnes'
export type {
  AgnesConfig,
  AgnesMessage,
  AgnesMessageRole,
  AgnesTool,
  AgnesToolCall,
  AgnesImageRequest,
  AgnesImageResponse,
  AgnesVideoRequest,
  AgnesVideoCreateResponse,
  AgnesVideoQueryResponse,
  AgnesVideoTaskStatus,
  AgnesSessionConfig,
} from './agnes'

/**
 * 获取所有可用的 Engine IDs
 */
export function getAvailableEngineIds(): string[] {
  return ['claude-code', 'codex', 'agnes']
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
    {
      id: 'codex',
      name: 'OpenAI Codex',
      description: 'OpenAI Codex CLI - 全部操作权限',
      available: true,
    },
    {
      id: 'agnes',
      name: 'Agnes Multi-Modal',
      description: 'Agnes AI 全模态引擎 — 对话 / 生图 / 生视频 / 图片编辑',
      available: false,
    },
  ]
}
