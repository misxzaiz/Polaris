/**
 * Engine Bootstrap - AI 引擎启动注册
 *
 * 在应用启动时按需注册 AI Engine。
 * UI/Core 通过 Registry 获取 Engine，而非直接 new。
 */

import { getEngineRegistry, registerEngine } from '../ai-runtime'
import { ClaudeCodeEngine } from '../engines/claude-code'
import { IFlowEngine } from '../engines/iflow'
import { CodexEngine, type CodexEngineConfig } from '../engines/codex'
import { getOpenAIProviderEngine, clearOpenAIProviderEngines, type OpenAIProviderEngineConfig } from '../engines/openai-provider'
import type { OpenAIProvider } from '../types/config'

/**
 * 已注册的 Engine ID 列表（传统引擎）
 */
export const REGISTERED_ENGINE_IDS = ['claude-code', 'iflow', 'codex'] as const

/**
 * Engine 类型
 */
export type EngineId = typeof REGISTERED_ENGINE_IDS[number] | `provider-${string}`

/**
 * 从配置动态注册 OpenAI Provider 引擎
 *
 * @param providers Provider 配置列表
 * @param activeProviderId 当前选中的 Provider ID
 */
export async function bootstrapOpenAIProviders(
  providers: OpenAIProvider[],
  activeProviderId?: string
): Promise<void> {
  // const registry = getEngineRegistry() // 未使用，保留以供未来扩展

  // 清空旧的 Provider 引擎缓存（从全局注册表注销）
  await clearOpenAIProviderEngines()

  // 为每个启用的 Provider 创建引擎
  for (const provider of providers) {
    if (!provider.enabled) continue

    try {
      const engineConfig: OpenAIProviderEngineConfig = {
        providerId: provider.id,
        providerName: provider.name,
        apiKey: provider.apiKey,
        apiBase: provider.apiBase,
        model: provider.model,
        temperature: provider.temperature,
        maxTokens: provider.maxTokens,
        supportsTools: provider.supportsTools,
      }

      const engine = getOpenAIProviderEngine(engineConfig)

      // 如果是当前选中的 Provider，设为默认引擎
      const isDefault = provider.id === activeProviderId
      registerEngine(engine, { asDefault: isDefault })

      await engine.initialize()

      console.log(`[EngineBootstrap] Registered provider: ${provider.name} (${engine.id})`)
    } catch (error) {
      console.error(`[EngineBootstrap] Failed to register provider ${provider.name}:`, error)
    }
  }
}

/**
 * 按需初始化 AI Engine
 *
 * @param defaultEngineId 默认引擎 ID
 * @param codexConfig Codex 引擎配置
 */
export async function bootstrapEngines(
  defaultEngineId: EngineId = 'claude-code',
  codexConfig?: CodexEngineConfig
): Promise<void> {
  const registry = getEngineRegistry()

  // 只注册默认引擎
  if (defaultEngineId === 'claude-code') {
    const claudeEngine = new ClaudeCodeEngine()
    registerEngine(claudeEngine, { asDefault: true })
  } else if (defaultEngineId === 'iflow') {
    const iflowEngine = new IFlowEngine()
    registerEngine(iflowEngine, { asDefault: true })
  } else if (defaultEngineId === 'codex') {
    const codexEngine = new CodexEngine(codexConfig)
    registerEngine(codexEngine, { asDefault: true })
  }

  // 初始化已注册的引擎
  await registry.initializeAll()

  console.log('[EngineBootstrap] Initialized default engine:', defaultEngineId)
}

/**
 * 延迟注册引擎（用于切换引擎时）
 *
 * @param engineId 要注册的引擎 ID
 * @param codexConfig Codex 引擎配置
 */
export async function registerEngineLazy(
  engineId: EngineId,
  codexConfig?: CodexEngineConfig
): Promise<void> {
  const registry = getEngineRegistry()

  // 如果已注册，跳过
  if (registry.has(engineId)) {
    return
  }

  if (engineId === 'claude-code') {
    const claudeEngine = new ClaudeCodeEngine()
    registerEngine(claudeEngine)
    await claudeEngine.initialize()
  } else if (engineId === 'iflow') {
    const iflowEngine = new IFlowEngine()
    registerEngine(iflowEngine)
    await iflowEngine.initialize()
  } else if (engineId === 'codex') {
    const codexEngine = new CodexEngine(codexConfig)
    registerEngine(codexEngine)
    await codexEngine.initialize()
  }

  console.log('[EngineBootstrap] Lazy registered engine:', engineId)
}

/**
 * 获取默认 Engine
 */
export function getDefaultEngine() {
  return getEngineRegistry().getDefault()
}

/**
 * 获取指定 Engine
 */
export function getEngine(engineId: EngineId) {
  return getEngineRegistry().get(engineId)
}

/**
 * 列出所有可用 Engine
 */
export function listEngines() {
  return getEngineRegistry().list()
}

/**
 * 检查 Engine 是否可用
 */
export async function isEngineAvailable(engineId: EngineId): Promise<boolean> {
  return await getEngineRegistry().isAvailable(engineId)
}
