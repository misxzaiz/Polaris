/**
 * Engine Bootstrap - AI 引擎启动注册
 *
 * 在应用启动时按需注册 AI Engine。
 * UI/Core 通过 Registry 获取 Engine，而非直接 new。
 */

import { getEngineRegistry, registerEngine } from '../ai-runtime'
import { ClaudeCodeEngine } from '../engines/claude-code'
import { CodexEngine } from '../engines/codex'
import { createLogger } from '../utils/logger'

const log = createLogger('EngineBootstrap')

/**
 * 已注册的 Engine ID 列表（传统引擎）
 */
export const REGISTERED_ENGINE_IDS = ['claude-code', 'codex'] as const

/**
 * Engine 类型
 */
export type EngineId = typeof REGISTERED_ENGINE_IDS[number]

/**
 * 按需初始化 AI Engine
 *
 * @param defaultEngineId 默认引擎 ID
 */
export async function bootstrapEngines(
  defaultEngineId: EngineId = 'claude-code'
): Promise<void> {
  const registry = getEngineRegistry()

  // 注册 Claude Code 引擎
  const claudeEngine = new ClaudeCodeEngine()
  registerEngine(claudeEngine, { asDefault: defaultEngineId === 'claude-code' })

  // 注册 Codex 引擎
  const codexEngine = new CodexEngine()
  registerEngine(codexEngine, { asDefault: defaultEngineId === 'codex' })

  // 初始化已注册的引擎
  await registry.initializeAll()

  log.info('Initialized engines', { defaultEngineId })
}

/**
 * 延迟注册引擎（用于切换引擎时）
 *
 * @param engineId 要注册的引擎 ID
 */
export async function registerEngineLazy(
  engineId: EngineId
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
  } else if (engineId === 'codex') {
    const codexEngine = new CodexEngine()
    registerEngine(codexEngine)
    await codexEngine.initialize()
  }

  log.info('Lazy registered engine', { engineId })
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
