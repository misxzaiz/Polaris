/**
 * 工具启动注册
 *
 * 在应用启动时注册所有可用的 AI 工具
 */

import { globalToolRegistry } from '@/ai-runtime'
import { todoTools } from '@/ai-runtime/tools/todoTools'
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

  log.info('All available tools', { tools: globalToolRegistry.listNames() })
}
