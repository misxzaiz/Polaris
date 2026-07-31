/**
 * Engine Bootstrap - AI 引擎启动注册
 *
 * 在应用启动时按需注册 AI Engine。
 * 使用 registerFactory 惰性创建，避免 StrictMode 双重调用。
 * UI/Core 通过 Registry 获取 Engine，而非直接 new。
 */

import { getEngineRegistry } from '@/ai-runtime'
import { ClaudeCodeEngine } from '../engines/claude-code'
import { CodexEngine } from '../engines/codex'
import { createLogger } from '@/utils/logger'

const log = createLogger('EngineBootstrap')

let bootstrapped = false

/**
 * 按需初始化 AI Engine
 *
 * @param defaultEngineId 默认引擎 ID
 */
export async function bootstrapEngines(
  defaultEngineId: string = 'claude-code',
): Promise<void> {
  if (bootstrapped) {
    log.debug('bootstrapEngines already called, skipping')
    return
  }
  bootstrapped = true

  const registry = getEngineRegistry()

  // 注册工厂（惰性创建：首次 get() 时才 new 实例）
  registry.registerFactory('claude-code', () => new ClaudeCodeEngine(), {
    asDefault: defaultEngineId === 'claude-code',
  })
  registry.registerFactory('codex', () => new CodexEngine(), {
    asDefault: defaultEngineId === 'codex',
  })

  // 只初始化默认引擎（其他引擎首次 get() 时自动初始化）
  await registry.initialize(defaultEngineId)

  log.info('Engines bootstrapped', { defaultEngineId })
}
