/**
 * 确保 Agnes 引擎已注册（运行时懒注册）
 *
 * 主聊天（agnesRunner）与漫剧管线（useComicPipeline）共享的引擎获取逻辑。
 * 引擎未注册时，从应用配置读取 API Key 进行懒注册。
 */

import { getEngineRegistry } from '@/ai-runtime'
import { AgnesMultiModalEngine } from '@/engines/agnes'
import { registerEngineLazy } from '@/core/engine-bootstrap'
import { useConfigStore } from '@/stores'
import { createLogger } from '@/utils/logger'

const log = createLogger('ensureAgnesEngine')

/** 引擎未注册 / API Key 缺失时抛出的错误 */
export class AgnesEngineNotAvailableError extends Error {
  constructor(reason: 'no_key' | 'register_failed') {
    const messages = {
      no_key: 'Agnes API Key 未配置。请在 设置 → AI 引擎 → Agnes AI 全模态 中输入你的 API Key 后重试。',
      register_failed: 'Agnes 引擎注册失败，请检查 API Key 是否正确。',
    }
    super(messages[reason])
    this.name = 'AgnesEngineNotAvailableError'
  }
}

/** 获取（必要时懒注册）Agnes 引擎实例 */
export async function ensureAgnesEngine(): Promise<AgnesMultiModalEngine> {
  const registry = getEngineRegistry()
  let engine = registry.get('agnes')

  if (engine instanceof AgnesMultiModalEngine) {
    return engine
  }

  // 引擎未注册，尝试从 config 读取 API Key 进行懒注册
  const appConfig = useConfigStore.getState().config
  const apiKey = appConfig?.agnesApiKey
  if (!apiKey) {
    throw new AgnesEngineNotAvailableError('no_key')
  }

  log.info('Lazy-registering Agnes engine from stored config')
  await registerEngineLazy('agnes', { apiKey })

  engine = registry.get('agnes')
  if (!(engine instanceof AgnesMultiModalEngine)) {
    throw new AgnesEngineNotAvailableError('register_failed')
  }
  return engine
}
