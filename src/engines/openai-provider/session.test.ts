/**
 * OpenAI Provider Session 单元测试
 *
 * 测试 OpenAIProviderSession 的核心功能，包括：
 * - Session 状态管理
 * - 消息处理
 * - 附件支持
 * - 事件发射与监听
 * - 资源清理
 *
 * 注意：OpenAIProviderSession 继承自 BaseSession 抽象类
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAIProviderSession, type OpenAIProviderSessionConfig } from './session'
import type { AITask } from '../../ai-runtime'

// Mock Tauri API
const mockInvoke = vi.fn()
const mockListen = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: any[]) => mockListen(...args),
}))

// Mock isTextFile
vi.mock('../../types/attachment', () => ({
  isTextFile: (mimeType: string) => mimeType.startsWith('text/'),
}))

// Suppress console.log
vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.spyOn(console, 'error').mockImplementation(() => {})

describe('OpenAIProviderSession', () => {
  let session: OpenAIProviderSession
  let mockUnlisten: () => void
  const defaultConfig: OpenAIProviderSessionConfig = {
    providerId: 'test-provider',
    providerName: 'Test Provider',
    apiKey: 'test-api-key',
    apiBase: 'https://api.test.com/v1',
    model: 'gpt-4',
    temperature: 0.7,
    maxTokens: 8192,
    timeout: 300000,
    supportsTools: true,
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockUnlisten = vi.fn()
    mockListen.mockResolvedValue(mockUnlisten)
    mockInvoke.mockResolvedValue('backend-session-id')

    session = new OpenAIProviderSession('test-session-id', defaultConfig)
  })

  afterEach(() => {
    session.dispose()
  })

  describe('基本属性', () => {
    it('应正确返回 session ID', () => {
      expect(session.id).toBe('test-session-id')
    })

    it('初始状态应为 idle', () => {
      expect(session.status).toBe('idle')
    })
  })

  describe('构造函数', () => {
    it('应使用提供的 ID 创建 Session', () => {
      const customSession = new OpenAIProviderSession('custom-id', defaultConfig)
      expect(customSession.id).toBe('custom-id')
      customSession.dispose()
    })

    it('应初始化系统消息', () => {
      const messages = session.getMessages()
      expect(messages.length).toBe(1)
      expect(messages[0].role).toBe('system')
    })
  })

  describe('消息管理', () => {
    it('getMessages 应返回消息数组', () => {
      const messages = session.getMessages()
      expect(Array.isArray(messages)).toBe(true)
    })

    it('clearMessages 应清除消息历史', () => {
      session.clearMessages()
      const messages = session.getMessages()
      expect(messages.length).toBe(1) // 保留系统消息
      expect(messages[0].role).toBe('system')
    })

    it('getMessages 应返回消息副本', () => {
      const messages1 = session.getMessages()
      const messages2 = session.getMessages()

      expect(messages1).not.toBe(messages2)
    })
  })

  describe('dispose', () => {
    it('应将状态设置为 disposed', () => {
      session.dispose()
      expect(session.status).toBe('disposed')
    })

    it('多次调用 dispose 不应报错', () => {
      session.dispose()
      session.dispose()
      session.dispose()
      expect(session.status).toBe('disposed')
    })
  })

  describe('事件监听', () => {
    it('应能添加事件监听器', () => {
      const listener = vi.fn()
      const unsubscribe = session.onEvent(listener)

      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })
  })

  describe('abort', () => {
    it('应能调用 abort', () => {
      session.abort()
      expect(session.status).toBe('idle')
    })

    it('abort 后状态应为 idle', () => {
      session.abort('task-1')
      expect(session.status).toBe('idle')
    })
  })

  describe('配置管理', () => {
    it('updateConfig 应合并配置', () => {
      session.updateConfig({ timeout: 60000 })
      const config = session.getConfig()
      expect(config.timeout).toBe(60000)
    })

    it('getConfig 应返回配置副本', () => {
      session.updateConfig({ timeout: 30000 })
      const config1 = session.getConfig()
      const config2 = session.getConfig()

      expect(config1).not.toBe(config2)
      expect(config1.timeout).toBe(config2.timeout)
    })
  })
})

describe('OpenAIProviderSession 任务执行', () => {
  let session: OpenAIProviderSession
  let mockUnlisten: () => void

  const defaultConfig: OpenAIProviderSessionConfig = {
    providerId: 'task-provider',
    providerName: 'Task Provider',
    apiKey: 'test-api-key',
    apiBase: 'https://api.test.com/v1',
    model: 'gpt-4',
    temperature: 0.7,
    maxTokens: 8192,
    timeout: 300000,
    supportsTools: true,
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockUnlisten = vi.fn()
    mockListen.mockResolvedValue(mockUnlisten)
    mockInvoke.mockResolvedValue('backend-session-id')

    session = new OpenAIProviderSession('task-session-id', defaultConfig)
  })

  afterEach(() => {
    session.dispose()
  })

  describe('run 方法', () => {
    it('应能处理基本聊天任务', async () => {
      const task: AITask = {
        id: 'task-1',
        kind: 'chat',
        input: { prompt: 'Hello' },
      }

      // 收集事件
      const events: any[] = []

      // 设置超时后发送 session_end 事件
      setTimeout(() => {
        session['emit']({ type: 'session_end', sessionId: session.id })
      }, 50)

      for await (const event of session.run(task)) {
        events.push(event)
        if (events.length >= 10) break // 防止无限循环
      }

      expect(events.length).toBeGreaterThan(0)
      expect(events[0].type).toBe('session_start')
    })

    it('应发送用户消息事件', async () => {
      const task: AITask = {
        id: 'task-2',
        kind: 'chat',
        input: { prompt: 'Hello Claude' },
      }

      const events: any[] = []

      setTimeout(() => {
        session['emit']({ type: 'session_end', sessionId: session.id })
      }, 50)

      for await (const event of session.run(task)) {
        events.push(event)
        if (events.length >= 10) break
      }

      const userMessage = events.find((e) => e.type === 'user_message')
      expect(userMessage).toBeDefined()
      if (userMessage && 'content' in userMessage) {
        expect(userMessage.content).toBe('Hello Claude')
      }
    })
  })
})

describe('OpenAIProviderSession 附件处理', () => {
  let session: OpenAIProviderSession
  let mockUnlisten: () => void

  const defaultConfig: OpenAIProviderSessionConfig = {
    providerId: 'attachment-provider',
    providerName: 'Attachment Provider',
    apiKey: 'test-api-key',
    apiBase: 'https://api.test.com/v1',
    model: 'gpt-4',
    temperature: 0.7,
    maxTokens: 8192,
    timeout: 300000,
    supportsTools: true,
    workspaceDir: '/test/workspace',
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockUnlisten = vi.fn()
    mockListen.mockResolvedValue(mockUnlisten)
    mockInvoke.mockResolvedValue('backend-session-id')

    session = new OpenAIProviderSession('attachment-session', defaultConfig)
  })

  afterEach(() => {
    session.dispose()
  })

  describe('工作区上下文', () => {
    it('系统消息应包含工作区目录', () => {
      const messages = session.getMessages()
      const systemMessage = messages.find((m) => m.role === 'system')

      expect(systemMessage).toBeDefined()
      expect(systemMessage?.content).toContain('/test/workspace')
    })
  })

  describe('run 带附件', () => {
    it('应能处理带附件的任务', async () => {
      const task: AITask = {
        id: 'task-attachment',
        kind: 'chat',
        input: {
          prompt: 'Analyze this image',
          extra: {
            attachments: [
              {
                type: 'image',
                fileName: 'test.png',
                mimeType: 'image/png',
                content: 'data:image/png;base64,iVBORw0KGgo=',
              },
            ],
          },
        },
      }

      const events: any[] = []

      setTimeout(() => {
        session['emit']({ type: 'session_end', sessionId: session.id })
      }, 50)

      for await (const event of session.run(task)) {
        events.push(event)
        if (events.length >= 10) break
      }

      expect(events.length).toBeGreaterThan(0)
    })
  })
})

describe('OpenAIProviderSession 错误处理', () => {
  let session: OpenAIProviderSession
  let mockUnlisten: () => void

  const defaultConfig: OpenAIProviderSessionConfig = {
    providerId: 'error-provider',
    providerName: 'Error Provider',
    apiKey: 'test-api-key',
    apiBase: 'https://api.test.com/v1',
    model: 'gpt-4',
    temperature: 0.7,
    maxTokens: 8192,
    timeout: 300000,
    supportsTools: true,
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockUnlisten = vi.fn()
    mockListen.mockResolvedValue(mockUnlisten)
    mockInvoke.mockResolvedValue('backend-session-id')

    session = new OpenAIProviderSession('error-session', defaultConfig)
  })

  afterEach(() => {
    session.dispose()
  })

  describe('dispose 后执行', () => {
    it('dispose 后 run 应抛出错误', async () => {
      session.dispose()

      const task: AITask = {
        id: 'error-task',
        kind: 'chat',
        input: { prompt: 'Hello' },
      }

      await expect(async () => {
        for await (const _ of session.run(task)) {
          // 不应到达
        }
      }).rejects.toThrow('Session 已被释放')
    })
  })

  describe('后端通信错误', () => {
    it('后端启动失败时应正确处理', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Backend error'))

      const task: AITask = {
        id: 'error-task',
        kind: 'chat',
        input: { prompt: 'Hello' },
      }

      const events: any[] = []

      // 即使后端失败，run 也应该能产生事件
      setTimeout(() => {
        session['emit']({ type: 'session_end', sessionId: session.id })
      }, 100)

      for await (const event of session.run(task)) {
        events.push(event)
        if (events.length >= 10) break
      }

      // session_start 和 user_message 应该仍然发送
      expect(events.length).toBeGreaterThan(0)
    })
  })
})

describe('OpenAIProviderSession 系统消息', () => {
  let session: OpenAIProviderSession
  let mockUnlisten: () => void

  const defaultConfig: OpenAIProviderSessionConfig = {
    providerId: 'system-msg-provider',
    providerName: 'System Message Provider',
    apiKey: 'test-api-key',
    apiBase: 'https://api.test.com/v1',
    model: 'gpt-4',
    temperature: 0.7,
    maxTokens: 8192,
    timeout: 300000,
    supportsTools: true,
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockUnlisten = vi.fn()
    mockListen.mockResolvedValue(mockUnlisten)
    mockInvoke.mockResolvedValue('backend-session-id')

    session = new OpenAIProviderSession('system-msg-session', defaultConfig)
  })

  afterEach(() => {
    session.dispose()
  })

  it('系统消息应包含正确的角色', () => {
    const messages = session.getMessages()
    const systemMessage = messages.find((m) => m.role === 'system')

    expect(systemMessage).toBeDefined()
  })

  it('clearMessages 后应重新初始化系统消息', () => {
    session.clearMessages()

    const messages = session.getMessages()
    expect(messages.length).toBe(1)
    expect(messages[0].role).toBe('system')
  })

  it('系统消息应包含模型相关信息', () => {
    const messages = session.getMessages()
    const systemMessage = messages.find((m) => m.role === 'system')

    expect(systemMessage?.content).toContain('AI 编程助手')
  })
})

describe('OpenAIProviderSession 配置管理', () => {
  let session: OpenAIProviderSession
  let mockUnlisten: () => void

  const customConfig: OpenAIProviderSessionConfig = {
    providerId: 'config-provider',
    providerName: 'Config Provider',
    apiKey: 'custom-api-key',
    apiBase: 'https://custom.api.com/v1',
    model: 'gpt-4-turbo',
    temperature: 0.5,
    maxTokens: 4096,
    timeout: 60000,
    supportsTools: false,
    workspaceDir: '/custom/workspace',
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockUnlisten = vi.fn()
    mockListen.mockResolvedValue(mockUnlisten)
    mockInvoke.mockResolvedValue('backend-session-id')

    session = new OpenAIProviderSession('config-session', customConfig)
  })

  afterEach(() => {
    session.dispose()
  })

  it('应正确使用自定义工作区', () => {
    const messages = session.getMessages()
    const systemMessage = messages.find((m) => m.role === 'system')
    expect(systemMessage?.content).toContain('/custom/workspace')
  })
})