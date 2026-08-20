/**
 * AI Tool Registry - AI 工具注册表
 *
 * 管理所有可供 AI 调用的工具，提供注册、查询、执行功能。
 */

import type { AITool, AIToolInput, AIToolResult } from './types/tool-types'
import { createLogger } from '@/utils/logger'

const log = createLogger('ToolRegistry')

/**
 * 工具注册表接口
 */
export interface ToolRegistry {
  /**
   * 注册工具
   * @param tool 要注册的工具
   */
  register(tool: AITool): void

  /**
   * 批量注册工具
   * @param tools 要注册的工具列表
   */
  registerBatch(tools: AITool[]): void

  /**
   * 获取工具
   * @param name 工具名称
   * @returns 工具实例，不存在则返回 undefined
   */
  get(name: string): AITool | undefined

  /**
   * 检查工具是否已注册
   * @param name 工具名称
   */
  has(name: string): boolean

  /**
   * 列出所有已注册工具的名称
   */
  listNames(): string[]

  /**
   * 列出所有工具
   */
  listAll(): AITool[]

  /**
   * 执行工具
   * @param name 工具名称
   * @param input 工具输入参数
   * @returns 工具执行结果
   */
  execute(name: string, input: AIToolInput): Promise<AIToolResult>

  /**
   * 生成 AI 系统提示词（工具使用说明）
   */
  generateSystemPrompt(): string

  /**
   * 注销工具
   * @param name 工具名称
   */
  unregister(name: string): void

  /**
   * 清空所有工具
   */
  clear(): void
}

/**
 * 工具注册表实现
 */
export class ToolRegistryImpl implements ToolRegistry {
  private tools = new Map<string, AITool>()

  register(tool: AITool): void {
    if (this.tools.has(tool.name)) {
      log.warn('Tool already registered, overwriting', { toolName: tool.name })
    }

    this.tools.set(tool.name, tool)
    log.info("Registered tool", { toolName: tool.name })
  }

  registerBatch(tools: AITool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  get(name: string): AITool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  listNames(): string[] {
    return Array.from(this.tools.keys())
  }

  listAll(): AITool[] {
    return Array.from(this.tools.values())
  }

  async execute(name: string, input: AIToolInput): Promise<AIToolResult> {
    const tool = this.tools.get(name)

    if (!tool) {
      return {
        success: false,
        error: `Tool "${name}" not found`,
        requiresConfirmation: false,
      }
    }

    try {
      log.info("Executing tool", { toolName: name, input })
      const result = await tool.execute(input)
      log.info("Tool completed", { toolName: name, success: result.success })
      return result
    } catch (error) {
      log.error(`Tool failed: ${name}`, error instanceof Error ? error : new Error(String(error)))
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        requiresConfirmation: false,
      }
    }
  }

  generateSystemPrompt(): string {
    if (this.tools.size === 0) {
      return ''
    }

    const sections: string[] = [
      '# Available Tools',
      '',
      'You can use the following tools to help the user manage tasks:',
      '',
    ]

    for (const tool of this.tools.values()) {
      sections.push(`## ${tool.name}`)
      sections.push(tool.description)

      if (tool.inputSchema?.properties) {
        sections.push('Parameters:')
        for (const [paramName, paramSchema] of Object.entries(tool.inputSchema.properties)) {
          const schema = paramSchema as {
            type: string
            description?: string
            enum?: string[]
            default?: string | number | boolean | null
          }
          const required = tool.inputSchema.required?.includes(paramName)
          const requiredText = required ? ' (required)' : ' (optional)'

          sections.push(
            `- \`${paramName}\`${requiredText}: ${schema.description || schema.type}`
          )

          // 显示枚举值
          if (schema.enum && Array.isArray(schema.enum)) {
            sections.push(`  - Options: ${schema.enum.join(', ')}`)
          }

          // 显示默认值
          if (schema.default !== undefined) {
            sections.push(`  - Default: ${schema.default}`)
          }
        }
      }

      sections.push('')
    }

    sections.push('## Tool Usage Guidelines')
    sections.push('')
    sections.push('- Always check if a tool is required before calling it')
    sections.push('- Use tools proactively when you detect user intent to manage todos')
    sections.push('- When a tool requires confirmation, ask the user first')
    sections.push('- Provide clear feedback about what actions you took')
    sections.push('')

    return sections.join('\n')
  }

  unregister(name: string): void {
    this.tools.delete(name)
    log.debug(`Unregistered tool: ${name}`)
  }

  clear(): void {
    this.tools.clear()
    log.debug('Cleared all tools')
  }
}

/**
 * 全局工具注册表单例
 */
export const globalToolRegistry = new ToolRegistryImpl()
