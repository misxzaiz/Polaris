/**
 * Agent Bootstrap - Agent Runner 启动注册
 *
 * 在应用启动时注册所有可用的 Agent Runner。
 * 新架构使用 AgentRunner 替代旧的 Engine。
 */

import { AgentRegistry } from './agents/AgentRunner'
import { ClaudeCodeAgentRunner } from './adapters/ClaudeCodeAgentRunner'
import { getClaudeEngine } from '../engines/claude-code'

/**
 * 已注册的 Agent ID 列表
 */
export const REGISTERED_AGENT_IDS = ['claude-code'] as const

/**
 * Agent 类型
 */
export type AgentId = typeof REGISTERED_AGENT_IDS[number]

/**
 * Agent 配置
 */
export interface AgentConfig {
  /** Claude Code CLI 路径 */
  claudePath?: string
  /** 默认工作区目录 */
  defaultWorkspaceDir?: string
}

/**
 * 默认配置（从应用配置读取）
 */
let defaultConfig: AgentConfig = {}

/**
 * 设置默认 Agent 配置
 *
 * @param config 配置
 */
export function setAgentConfig(config: AgentConfig): void {
  defaultConfig = config
}

/**
 * 初始化所有 Agent Runner
 *
 * 在应用启动时调用，注册所有可用的 Agent。
 *
 * @param config Agent 配置
 */
export async function bootstrapAgents(config?: AgentConfig): Promise<void> {
  if (config) {
    defaultConfig = config
  }

  // 注册 Claude Code Agent
  const claudeAgent = new ClaudeCodeAgentRunner(
    {
      claudePath: defaultConfig.claudePath,
      defaultWorkspaceDir: defaultConfig.defaultWorkspaceDir,
    },
    () => getClaudeEngine({
      claudePath: defaultConfig.claudePath,
      defaultWorkspaceDir: defaultConfig.defaultWorkspaceDir,
    })
  )
  AgentRegistry.register(claudeAgent)

  // 初始化所有 Agent
  const agents = AgentRegistry.getAll()
  for (const agent of agents) {
    if (agent.initialize) {
      await agent.initialize()
    }
  }

  console.log('[AgentBootstrap] All agents initialized')
}

/**
 * 获取可用的 Agent 列表
 */
export async function getAvailableAgents(): Promise<AgentId[]> {
  const availableAgents = await AgentRegistry.getAvailableAgents()
  return availableAgents.map(agent => agent.id as AgentId)
}

/**
 * 获取默认 Agent ID
 */
export function getDefaultAgentId(): AgentId {
  return 'claude-code'
}

/**
 * 检查 Agent 是否可用
 *
 * @param agentId Agent ID
 */
export async function isAgentAvailable(agentId: AgentId): Promise<boolean> {
  if (!AgentRegistry.has(agentId)) {
    return false
  }

  const agent = AgentRegistry.get(agentId)
  return await agent.isAvailable()
}