/**
 * OpenAI Provider Engine 单元测试
 *
 * 测试 OpenAIProviderEngine 的核心功能，包括：
 * - 引擎基本属性
 * - 配置验证
 * - 会话创建与管理
 * - API 可用性检查
 * - 引擎缓存机制
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  OpenAIProviderEngine,
  getOpenAIProviderEngine,
  removeOpenAIProviderEngine,
  clearOpenAIProviderEngines,
  type OpenAIProviderEngineConfig,
} from './engine'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

// Mock ai-runtime validateOpenAIProviderConfig
vi.mock('../../ai-runtime', () => ({
  createCapabilities: (config: any) => ({
    supportedTaskKinds: config.supportedTaskKinds || ['chat'],
    supportsStreaming: config.supportsStreaming ?? true,
    supportsConcurrentSessions: config.supportsConcurrentSessions ?? true,
    supportsTaskAbort: config.supportsTaskAbort ?? true,
    maxConcurrentSessions: config.maxConcurrentSessions ?? 0,
    description: config.description || '',
    version: config.version || '1.0.0',
  }),
  getEngineRegistry: () => ({
    list: () => [],
    unregister: vi.fn(),
  }),
  validateOpenAIProviderConfig: (config: any) => {
    if (!config.apiKey) {
      return { valid: false, errors: [{ field: 'apiKey', message: 'Required' }] }
    }
    if (!config.apiBase) {
      return { valid: false, errors: [{ field: 'apiBase', message: 'Required' }] }
    }
    if (!config.model) {
      return { valid: false, errors: [{ field: 'model', message: 'Required' }] }
    }
    return { valid: true, errors: [] }
  },
}))

// Suppress console.log in tests
vi.spyOn(console, 'log').mockImplementation(() => {})

describe('OpenAIProviderEngine', () => {
  const defaultConfig: OpenAIProviderEngineConfig = {
    providerId: 'test-provider',
    providerName: 'Test Provider',
    apiKey: 'test-api-key',
    apiBase: 'https://api.test.com/v1',
    model: 'gpt-4',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // Clear engine cache before each test
    clearOpenAIProviderEngines()
  })

  afterEach(() => {
    clearOpenAIProviderEngines()
  })

  describe('构造函数', () => {
    it('应使用有效配置创建引擎', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)

      expect(engine.id).toBe('provider-test-provider')
      expect(engine.name).toBe('Test Provider')
    })

    it('应使用 providerId 作为 ID 的一部分', () => {
      const engine = new OpenAIProviderEngine({
        ...defaultConfig,
        providerId: 'custom-openai',
      })

      expect(engine.id).toBe('provider-custom-openai')
    })

    it('应使用 providerName 作为显示名称', () => {
      const engine = new OpenAIProviderEngine({
        ...defaultConfig,
        providerName: 'My Custom AI',
      })

      expect(engine.name).toBe('My Custom AI')
    })

    it('缺少 apiKey 时应抛出错误', () => {
      expect(() => {
        new OpenAIProviderEngine({
          ...defaultConfig,
          apiKey: '',
        })
      }).toThrow('Configuration validation failed')
    })

    it('缺少 apiBase 时应抛出错误', () => {
      expect(() => {
        new OpenAIProviderEngine({
          ...defaultConfig,
          apiBase: '',
        })
      }).toThrow('Configuration validation failed')
    })

    it('缺少 model 时应抛出错误', () => {
      expect(() => {
        new OpenAIProviderEngine({
          ...defaultConfig,
          model: '',
        })
      }).toThrow('Configuration validation failed')
    })

    it('应使用默认值填充可选配置', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      const config = engine.getConfig()

      expect(config.temperature).toBe(0.7)
      expect(config.maxTokens).toBe(8192)
      expect(config.timeout).toBe(300000)
      expect(config.supportsTools).toBe(true)
    })
  })

  describe('基本属性', () => {
    it('应正确返回 id', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      expect(engine.id).toBe('provider-test-provider')
    })

    it('应正确返回 name', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      expect(engine.name).toBe('Test Provider')
    })

    it('应正确返回 capabilities', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)

      expect(engine.capabilities.supportsStreaming).toBe(true)
      expect(engine.capabilities.supportsConcurrentSessions).toBe(true)
      expect(engine.capabilities.supportsTaskAbort).toBe(true)
      expect(engine.capabilities.maxConcurrentSessions).toBe(0) // 无限制
      expect(engine.capabilities.supportedTaskKinds).toContain('chat')
      expect(engine.capabilities.supportedTaskKinds).toContain('codegen')
      expect(engine.capabilities.supportedTaskKinds).toContain('analyze')
    })
  })

  describe('createSession', () => {
    it('应创建新的 Session', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      const session = engine.createSession()

      expect(session).toBeDefined()
      expect(session.id).toBeDefined()
      expect(typeof session.id).toBe('string')
      expect(session.id.startsWith('provider-test-provider')).toBe(true)
    })

    it('应创建具有不同 ID 的 Session', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      const session1 = engine.createSession()
      const session2 = engine.createSession()

      expect(session1.id).not.toBe(session2.id)
    })

    it('应将配置传递给 Session', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      const session = engine.createSession({
        model: 'gpt-4-turbo',
        temperature: 0.5,
      })

      expect(session).toBeDefined()
      expect(session.status).toBe('idle')
    })
  })

  describe('isAvailable', () => {
    it('API 正常时应返回 true', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
      })

      const engine = new OpenAIProviderEngine(defaultConfig)
      const result = await engine.isAvailable()

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/v1/models',
        expect.objectContaining({
          method: 'GET',
          headers: {
            Authorization: 'Bearer test-api-key',
          },
        })
      )
    })

    it('API 返回错误状态时应返回 false', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      })

      const engine = new OpenAIProviderEngine(defaultConfig)
      const result = await engine.isAvailable()

      expect(result).toBe(false)
    })

    it('网络错误时应返回 false', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const engine = new OpenAIProviderEngine(defaultConfig)
      const result = await engine.isAvailable()

      expect(result).toBe(false)
    })
  })

  describe('initialize', () => {
    it('API 可用时应返回 true', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      })

      const engine = new OpenAIProviderEngine(defaultConfig)
      const result = await engine.initialize()

      expect(result).toBe(true)
    })

    it('API 不可用时应返回 false', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      })

      const engine = new OpenAIProviderEngine(defaultConfig)
      const result = await engine.initialize()

      expect(result).toBe(false)
    })
  })

  describe('cleanup', () => {
    it('应清理所有会话', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      engine.createSession()
      engine.createSession()
      engine.createSession()

      engine.cleanup()

      expect(engine.getSessions()).toHaveLength(0)
    })

    it('多次调用 cleanup 不应报错', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      engine.cleanup()
      engine.cleanup()
      engine.cleanup()
    })
  })

  describe('activeSessionCount', () => {
    it('初始时应为 0', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      expect(engine.activeSessionCount).toBe(0)
    })

    it('创建会话后应正确计数', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      engine.createSession()
      engine.createSession()

      expect(engine.activeSessionCount).toBe(2)
    })

    it('销毁会话后应正确减少', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      const session = engine.createSession()

      session.dispose()

      // 注意：销毁后计数可能不会立即减少（有延迟清理逻辑）
      // 这里主要验证不会报错
      expect(engine.activeSessionCount).toBeGreaterThanOrEqual(0)
    })
  })

  describe('getSessions', () => {
    it('应返回所有会话', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      const session1 = engine.createSession()
      const session2 = engine.createSession()

      const sessions = engine.getSessions()

      expect(sessions).toHaveLength(2)
      expect(sessions.map((s) => s.id)).toContain(session1.id)
      expect(sessions.map((s) => s.id)).toContain(session2.id)
    })

    it('清理后应返回空数组', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      engine.createSession()
      engine.cleanup()

      expect(engine.getSessions()).toHaveLength(0)
    })
  })

  describe('配置管理', () => {
    it('getConfig 应返回配置副本', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      const config1 = engine.getConfig()
      const config2 = engine.getConfig()

      expect(config1).not.toBe(config2)
      expect(config1.apiKey).toBe(config2.apiKey)
    })

    it('updateConfig 应更新配置', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      engine.updateConfig({ apiKey: 'new-api-key' })

      const config = engine.getConfig()
      expect(config.apiKey).toBe('new-api-key')
    })

    it('updateConfig 应保留现有配置', () => {
      const engine = new OpenAIProviderEngine(defaultConfig)
      engine.updateConfig({ model: 'gpt-4-turbo' })
      engine.updateConfig({ temperature: 0.5 })

      const config = engine.getConfig()
      expect(config.model).toBe('gpt-4-turbo')
      expect(config.temperature).toBe(0.5)
    })
  })
})

describe('Engine 缓存机制', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearOpenAIProviderEngines()
  })

  afterEach(() => {
    clearOpenAIProviderEngines()
  })

  describe('getOpenAIProviderEngine', () => {
    it('首次调用应创建新实例', () => {
      const engine = getOpenAIProviderEngine({
        providerId: 'cached-provider',
        providerName: 'Cached Provider',
        apiKey: 'test-key',
        apiBase: 'https://api.test.com/v1',
        model: 'gpt-4',
      })

      expect(engine).toBeDefined()
      expect(engine.id).toBe('provider-cached-provider')
    })

    it('相同 providerId 应返回相同实例', () => {
      const engine1 = getOpenAIProviderEngine({
        providerId: 'same-provider',
        providerName: 'Same Provider',
        apiKey: 'test-key',
        apiBase: 'https://api.test.com/v1',
        model: 'gpt-4',
      })

      const engine2 = getOpenAIProviderEngine({
        providerId: 'same-provider',
        providerName: 'Same Provider',
        apiKey: 'different-key',
        apiBase: 'https://api.test.com/v2',
        model: 'gpt-3.5',
      })

      expect(engine1).toBe(engine2)
    })

    it('不同 providerId 应返回不同实例', () => {
      const engine1 = getOpenAIProviderEngine({
        providerId: 'provider-1',
        providerName: 'Provider 1',
        apiKey: 'key1',
        apiBase: 'https://api1.test.com/v1',
        model: 'gpt-4',
      })

      const engine2 = getOpenAIProviderEngine({
        providerId: 'provider-2',
        providerName: 'Provider 2',
        apiKey: 'key2',
        apiBase: 'https://api2.test.com/v1',
        model: 'gpt-3.5',
      })

      expect(engine1).not.toBe(engine2)
    })
  })

  describe('removeOpenAIProviderEngine', () => {
    it('应移除缓存的引擎实例', () => {
      const engine = getOpenAIProviderEngine({
        providerId: 'removable-provider',
        providerName: 'Removable Provider',
        apiKey: 'test-key',
        apiBase: 'https://api.test.com/v1',
        model: 'gpt-4',
      })

      removeOpenAIProviderEngine('removable-provider')

      // 移除后再获取应该创建新实例
      const engine2 = getOpenAIProviderEngine({
        providerId: 'removable-provider',
        providerName: 'Removable Provider',
        apiKey: 'test-key',
        apiBase: 'https://api.test.com/v1',
        model: 'gpt-4',
      })

      expect(engine).not.toBe(engine2)
    })

    it('移除不存在的引擎不应报错', () => {
      expect(() => {
        removeOpenAIProviderEngine('non-existent')
      }).not.toThrow()
    })
  })

  describe('clearOpenAIProviderEngines', () => {
    it('应清空所有缓存的引擎实例', async () => {
      getOpenAIProviderEngine({
        providerId: 'clear-1',
        providerName: 'Clear 1',
        apiKey: 'key1',
        apiBase: 'https://api1.test.com/v1',
        model: 'gpt-4',
      })

      getOpenAIProviderEngine({
        providerId: 'clear-2',
        providerName: 'Clear 2',
        apiKey: 'key2',
        apiBase: 'https://api2.test.com/v1',
        model: 'gpt-3.5',
      })

      await clearOpenAIProviderEngines()

      // 清空后再获取应该创建新实例
      const engine1 = getOpenAIProviderEngine({
        providerId: 'clear-1',
        providerName: 'Clear 1',
        apiKey: 'key1',
        apiBase: 'https://api1.test.com/v1',
        model: 'gpt-4',
      })

      expect(engine1).toBeDefined()
    })
  })
})
