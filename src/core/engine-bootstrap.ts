/**
 * Engine Bootstrap - AI 引擎启动注册
 *
 * 在应用启动时按需注册 AI Engine。
 * 使用 registerFactory 惰性创建，避免 StrictMode 双重调用。
 * UI/Core 通过 Registry 获取 Engine，而非直接 new。
 *
 * 引擎列表从后端 get_engine_metadata_list 动态获取，
 * 新增引擎只需在后端注册到 EngineRegistry，前端自动感知。
 */

import { getEngineRegistry } from '@/ai-runtime'
import { ClaudeCodeEngine } from '../engines/claude-code'
import { CodexEngine } from '../engines/codex'
import { createLogger } from '@/utils/logger'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'

const log = createLogger('EngineBootstrap')

let bootstrapped = false

/**
 * 前端引擎工厂映射。
 * 只有有前端实现的引擎才需要注册工厂。
 * 无前端实现的引擎（SimpleAI、Pi）的实际 AI 调用由后端直接处理。
 */
const ENGINE_FACTORIES: Record<string, () => import('@/ai-runtime').AIEngine> = {
  'claude-code': () => new ClaudeCodeEngine(),
  codex: () => new CodexEngine(),
}

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

  // 先加载后端引擎元数据列表
  const metadataStore = useEngineMetadataStore.getState()
  if (!metadataStore.loaded) {
    await metadataStore.load()
  }

  // 从后端元数据获取所有引擎 ID，注册有前端实现的引擎
  const engineIds = useEngineMetadataStore.getState().getEngineIds()
  let hasRegisteredDefault = false

  for (const engineId of engineIds) {
    if (ENGINE_FACTORIES[engineId]) {
      const isDefault = engineId === defaultEngineId
      registry.registerFactory(engineId, ENGINE_FACTORIES[engineId], {
        asDefault: isDefault,
      })
      if (isDefault) {
        hasRegisteredDefault = true
      }
      log.debug(`Registered engine factory: ${engineId}${isDefault ? ' (default)' : ''}`)
    } else {
      log.debug(`Skipping frontend factory for ${engineId} (no frontend implementation, backend handles AI calls)`)
    }
  }

  // 如果没有匹配到默认引擎，使用第一个注册的引擎
  if (!hasRegisteredDefault && engineIds.length > 0) {
    const firstId = engineIds[0]
    if (ENGINE_FACTORIES[firstId]) {
      registry.registerFactory(firstId, ENGINE_FACTORIES[firstId], {
        asDefault: true,
      })
    }
  }

  // 先通过 get() 触发惰性工厂创建实例，确保 initialize() 能找到。
  // registerFactory 只存工厂不进 engines Map，而 initialize 只查 engines Map。
  // 若配置的默认引擎没有前端实现（如插件引擎 "omp"，由后端处理 AI 调用），
  // 则回退到注册表中实际可用的默认引擎，避免 initialize 报 "not registered"。
  let targetEngineId = defaultEngineId
  if (!registry.get(targetEngineId)) {
    targetEngineId = registry.getDefaultId() ?? defaultEngineId
    if (!registry.get(targetEngineId)) {
      log.warn(
        `No frontend engine available for default "${defaultEngineId}", skipping engine initialization`,
        { engineIds },
      )
      return
    }
  }

  // 只初始化默认引擎（其他引擎首次 get() 时自动初始化）
  await registry.initialize(targetEngineId)

  log.info('Engines bootstrapped', { defaultEngineId, targetEngineId, engineCount: engineIds.length })
}