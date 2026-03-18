/**
 * tool-registry.ts 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ToolRegistryImpl, globalToolRegistry } from './tool-registry'
import type { AITool, AIToolInput, AIToolResult } from './types/tool-types'

// Mock console
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
}

// 创建测试工具的工厂函数
function createMockTool(overrides: Partial<AITool> = {}): AITool {
  return {
    name: 'test_tool',
    description: 'A test tool for unit testing',
    inputSchema: {
      properties: {
        message: {
          type: 'string',
          description: 'A message to process',
        },
        count: {
          type: 'number',
          description: 'Number of times to repeat',
          default: 1,
        },
      },
      required: ['message'],
    },
    execute: vi.fn(async (input: AIToolInput): Promise<AIToolResult> => ({
      success: true,
      data: input,
    })),
    ...overrides,
  }
}

describe('ToolRegistryImpl', () => {
  let registry: ToolRegistryImpl

  beforeEach(() => {
    registry = new ToolRegistryImpl()
    console.log = vi.fn()
    console.warn = vi.fn()
    console.error = vi.fn()
  })

  afterEach(() => {
    console.log = originalConsole.log
    console.warn = originalConsole.warn
    console.error = originalConsole.error
  })

  describe('register', () => {
    it('should register a tool successfully', () => {
      const tool = createMockTool()
      registry.register(tool)

      expect(registry.has('test_tool')).toBe(true)
      expect(console.log).toHaveBeenCalledWith(
        '[ToolRegistry] Registered tool: test_tool'
      )
    })

    it('should warn when registering a duplicate tool', () => {
      const tool1 = createMockTool()
      const tool2 = createMockTool()

      registry.register(tool1)
      registry.register(tool2)

      expect(console.warn).toHaveBeenCalledWith(
        '[ToolRegistry] Tool "test_tool" is already registered, overwriting...'
      )
    })

    it('should overwrite existing tool when registering duplicate', () => {
      const tool1 = createMockTool({ description: 'First tool' })
      const tool2 = createMockTool({ description: 'Second tool' })

      registry.register(tool1)
      registry.register(tool2)

      const retrieved = registry.get('test_tool')
      expect(retrieved?.description).toBe('Second tool')
    })
  })

  describe('registerBatch', () => {
    it('should register multiple tools', () => {
      const tools = [
        createMockTool({ name: 'tool1' }),
        createMockTool({ name: 'tool2' }),
        createMockTool({ name: 'tool3' }),
      ]

      registry.registerBatch(tools)

      expect(registry.has('tool1')).toBe(true)
      expect(registry.has('tool2')).toBe(true)
      expect(registry.has('tool3')).toBe(true)
    })

    it('should handle empty array', () => {
      registry.registerBatch([])
      expect(registry.listNames()).toEqual([])
    })
  })

  describe('get', () => {
    it('should return tool when exists', () => {
      const tool = createMockTool()
      registry.register(tool)

      const result = registry.get('test_tool')
      expect(result).toBe(tool)
    })

    it('should return undefined when tool not found', () => {
      const result = registry.get('nonexistent')
      expect(result).toBeUndefined()
    })
  })

  describe('has', () => {
    it('should return true when tool exists', () => {
      const tool = createMockTool()
      registry.register(tool)

      expect(registry.has('test_tool')).toBe(true)
    })

    it('should return false when tool does not exist', () => {
      expect(registry.has('nonexistent')).toBe(false)
    })
  })

  describe('listNames', () => {
    it('should return empty array when no tools registered', () => {
      expect(registry.listNames()).toEqual([])
    })

    it('should return all registered tool names', () => {
      registry.register(createMockTool({ name: 'tool_a' }))
      registry.register(createMockTool({ name: 'tool_b' }))

      const names = registry.listNames()
      expect(names).toContain('tool_a')
      expect(names).toContain('tool_b')
      expect(names.length).toBe(2)
    })
  })

  describe('listAll', () => {
    it('should return empty array when no tools registered', () => {
      expect(registry.listAll()).toEqual([])
    })

    it('should return all registered tools', () => {
      const tool1 = createMockTool({ name: 'tool1' })
      const tool2 = createMockTool({ name: 'tool2' })

      registry.register(tool1)
      registry.register(tool2)

      const tools = registry.listAll()
      expect(tools).toContain(tool1)
      expect(tools).toContain(tool2)
      expect(tools.length).toBe(2)
    })
  })

  describe('execute', () => {
    it('should execute tool successfully', async () => {
      const tool = createMockTool()
      registry.register(tool)

      const input = { message: 'hello', count: 3 }
      const result = await registry.execute('test_tool', input)

      expect(result.success).toBe(true)
      expect(result.data).toEqual(input)
      expect(tool.execute).toHaveBeenCalledWith(input)
    })

    it('should return failure when tool not found', async () => {
      const result = await registry.execute('nonexistent', {})

      expect(result.success).toBe(false)
      expect(result.error).toBe('Tool "nonexistent" not found')
      expect(result.requiresConfirmation).toBe(false)
    })

    it('should handle tool execution error', async () => {
      const tool = createMockTool({
        execute: vi.fn().mockRejectedValue(new Error('Execution failed')),
      })
      registry.register(tool)

      const result = await registry.execute('test_tool', {})

      expect(result.success).toBe(false)
      expect(result.error).toBe('Execution failed')
      expect(result.requiresConfirmation).toBe(false)
    })

    it('should handle non-Error thrown values', async () => {
      const tool = createMockTool({
        execute: vi.fn().mockRejectedValue('string error'),
      })
      registry.register(tool)

      const result = await registry.execute('test_tool', {})

      expect(result.success).toBe(false)
      expect(result.error).toBe('string error')
    })

    it('should log execution start and completion', async () => {
      const tool = createMockTool()
      registry.register(tool)

      await registry.execute('test_tool', { message: 'test' })

      expect(console.log).toHaveBeenCalledWith(
        '[ToolRegistry] Executing tool: test_tool',
        { message: 'test' }
      )
      expect(console.log).toHaveBeenCalledWith(
        '[ToolRegistry] Tool test_tool completed:',
        expect.objectContaining({ success: true })
      )
    })

    it('should log error on failure', async () => {
      const tool = createMockTool({
        execute: vi.fn().mockRejectedValue(new Error('fail')),
      })
      registry.register(tool)

      await registry.execute('test_tool', {})

      expect(console.error).toHaveBeenCalledWith(
        '[ToolRegistry] Tool test_tool failed:',
        expect.any(Error)
      )
    })
  })

  describe('generateSystemPrompt', () => {
    it('should return empty string when no tools registered', () => {
      expect(registry.generateSystemPrompt()).toBe('')
    })

    it('should generate system prompt with single tool', () => {
      const tool = createMockTool()
      registry.register(tool)

      const prompt = registry.generateSystemPrompt()

      expect(prompt).toContain('# Available Tools')
      expect(prompt).toContain('## test_tool')
      expect(prompt).toContain('A test tool for unit testing')
      expect(prompt).toContain('`message` (required)')
      expect(prompt).toContain('`count` (optional)')
    })

    it('should show enum options in prompt', () => {
      const tool = createMockTool({
        name: 'status_tool',
        inputSchema: {
          properties: {
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
            },
          },
        },
      })
      registry.register(tool)

      const prompt = registry.generateSystemPrompt()

      expect(prompt).toContain('Options: pending, in_progress, completed')
    })

    it('should show default value in prompt', () => {
      const tool = createMockTool()
      registry.register(tool)

      const prompt = registry.generateSystemPrompt()

      expect(prompt).toContain('Default: 1')
    })

    it('should generate prompt for multiple tools', () => {
      registry.register(createMockTool({ name: 'tool1', description: 'First tool' }))
      registry.register(createMockTool({ name: 'tool2', description: 'Second tool' }))

      const prompt = registry.generateSystemPrompt()

      expect(prompt).toContain('## tool1')
      expect(prompt).toContain('First tool')
      expect(prompt).toContain('## tool2')
      expect(prompt).toContain('Second tool')
    })

    it('should include tool usage guidelines', () => {
      registry.register(createMockTool())

      const prompt = registry.generateSystemPrompt()

      expect(prompt).toContain('## Tool Usage Guidelines')
      expect(prompt).toContain('Always check if a tool is required before calling it')
    })

    it('should handle tool without inputSchema properties', () => {
      const tool: AITool = {
        name: 'simple_tool',
        description: 'A simple tool',
        inputSchema: {},
        execute: vi.fn(),
      }
      registry.register(tool)

      const prompt = registry.generateSystemPrompt()

      expect(prompt).toContain('## simple_tool')
      expect(prompt).toContain('A simple tool')
    })
  })

  describe('unregister', () => {
    it('should remove tool from registry', () => {
      registry.register(createMockTool())
      expect(registry.has('test_tool')).toBe(true)

      registry.unregister('test_tool')

      expect(registry.has('test_tool')).toBe(false)
      // unregister 使用 log.debug，不再直接调用 console.log
    })

    it('should handle unregistering non-existent tool silently', () => {
      // Should not throw
      registry.unregister('nonexistent')
      // unregister 使用 log.debug，不再直接调用 console.log
      expect(true).toBe(true)
    })
  })

  describe('clear', () => {
    it('should remove all tools', () => {
      registry.register(createMockTool({ name: 'tool1' }))
      registry.register(createMockTool({ name: 'tool2' }))
      registry.register(createMockTool({ name: 'tool3' }))

      registry.clear()

      expect(registry.listNames()).toEqual([])
      // clear 使用 log.debug，不再直接调用 console.log
    })
  })
})

describe('globalToolRegistry', () => {
  it('should be a ToolRegistryImpl instance', () => {
    expect(globalToolRegistry).toBeInstanceOf(ToolRegistryImpl)
  })
})
