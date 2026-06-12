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

// 导出 Mimo Code Engine
export { MimoCodeEngine, getMimoEngine } from './mimo'
export type { MimoEngineConfig } from './mimo'
export { MimoCodeSession, createMimoSession } from './mimo'
export type { MimoSessionConfig } from './mimo'

/**
 * 获取所有可用的 Engine IDs
 */
export function getAvailableEngineIds(): string[] {
  return ['claude-code', 'codex', 'agnes', 'simple-ai', 'mimo']
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
    {
      id: 'simple-ai',
      name: 'Simple AI',
      description: '轻量级 AI 助手 — 使用模型供应商配置，内置 bash/文件工具',
      available: true,
    },
    {
      id: 'mimo',
      name: 'Mimo Code',
      description: 'Mimo (Mimocode) CLI - 多提供商 AI 编程助手，支持内置认证',
      available: true,
    },
  ]
}
