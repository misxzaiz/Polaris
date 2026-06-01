/**
 * 工具启动注册
 *
 * 在应用启动时注册所有可用的 AI 工具
 */

import { globalToolRegistry } from '@/ai-runtime'
import { todoTools } from '@/ai-runtime/tools/todoTools'
import { agnesTools } from '@/ai-runtime/tools/agnesTools'
import { createLogger } from '@/utils/logger'

const log = createLogger('ToolBootstrap')

/**
 * 注册所有 AI 工具
 */
export function bootstrapTools(): void {
  log.info('Registering AI tools...')

  // 注册待办工具
  for (const tool of todoTools) {
    globalToolRegistry.register(tool)
  }
  log.info('Todo tools registered', { count: todoTools.length })

  // 注册 Agnes 多模态工具
  for (const tool of agnesTools) {
    globalToolRegistry.register(tool)
  }
  log.info('Agnes multimodal tools registered', { count: agnesTools.length })

  log.info('All available tools', { tools: globalToolRegistry.listNames() })
}
