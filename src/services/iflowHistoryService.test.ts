/**
 * iflowHistoryService 单元测试
 *
 * 测试覆盖：
 * 1. listSessions - 列出所有 IFlow 会话
 * 2. getSessionHistory - 获取会话历史
 * 3. getFileContexts - 获取文件上下文
 * 4. getTokenStats - 获取 Token 统计
 * 5. convertMessagesToFormat - 消息格式转换
 * 6. extractToolCalls - 提取工具调用
 * 7. generateSessionTitle - 生成会话标题
 * 8. getSessionSummary - 获取会话摘要
 * 9. 工具函数: formatFileSize, formatTime
 * 10. 单例模式
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  IFlowHistoryService,
  getIFlowHistoryService,
  resetIFlowHistoryService,
  type IFlowSessionMeta,
  type IFlowHistoryMessage,
  type IFlowTokenStats,
} from './iflowHistoryService'
import { invoke } from '@tauri-apps/api/core'

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

// Mock logger
vi.mock('../utils/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}))

describe('IFlowHistoryService', () => {
  let service: IFlowHistoryService

  beforeEach(() => {
    vi.clearAllMocks()
    resetIFlowHistoryService()
    service = new IFlowHistoryService()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ===========================================================================
  // listSessions 测试
  // ===========================================================================

  describe('listSessions', () => {
    it('应正确返回会话列表', async () => {
      const mockSessions: IFlowSessionMeta[] = [
        {
          sessionId: 'session-1',
          title: 'Test Session',
          messageCount: 5,
          fileSize: 1024,
          createdAt: '2026-03-19T10:00:00Z',
          updatedAt: '2026-03-19T11:00:00Z',
          inputTokens: 100,
          outputTokens: 200,
        },
      ]

      vi.mocked(invoke).mockResolvedValue(mockSessions)

      const result = await service.listSessions()

      expect(result).toHaveLength(1)
      expect(result[0].sessionId).toBe('session-1')
      expect(result[0].title).toBe('Test Session')
      expect(invoke).toHaveBeenCalledWith('list_iflow_sessions')
    })

    it('应返回空数组当没有会话时', async () => {
      vi.mocked(invoke).mockResolvedValue([])

      const result = await service.listSessions()

      expect(result).toEqual([])
    })

    it('应在错误时返回空数组', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('Network error'))

      const result = await service.listSessions()

      expect(result).toEqual([])
    })

    it('应正确处理多个会话', async () => {
      const mockSessions: IFlowSessionMeta[] = [
        { sessionId: 's1', title: 'Session 1', messageCount: 1, fileSize: 100, createdAt: '2026-03-19T10:00:00Z', updatedAt: '2026-03-19T11:00:00Z', inputTokens: 10, outputTokens: 20 },
        { sessionId: 's2', title: 'Session 2', messageCount: 2, fileSize: 200, createdAt: '2026-03-19T09:00:00Z', updatedAt: '2026-03-19T10:00:00Z', inputTokens: 20, outputTokens: 40 },
        { sessionId: 's3', title: 'Session 3', messageCount: 3, fileSize: 300, createdAt: '2026-03-19T08:00:00Z', updatedAt: '2026-03-19T09:00:00Z', inputTokens: 30, outputTokens: 60 },
      ]

      vi.mocked(invoke).mockResolvedValue(mockSessions)

      const result = await service.listSessions()

      expect(result).toHaveLength(3)
    })

    it('应正确处理包含特殊字符的会话标题', async () => {
      const mockSessions: IFlowSessionMeta[] = [
        { sessionId: 's1', title: '测试 <script>alert(1)</script>', messageCount: 1, fileSize: 100, createdAt: '2026-03-19T10:00:00Z', updatedAt: '2026-03-19T11:00:00Z', inputTokens: 10, outputTokens: 20 },
      ]

      vi.mocked(invoke).mockResolvedValue(mockSessions)

      const result = await service.listSessions()

      expect(result[0].title).toBe('测试 <script>alert(1)</script>')
    })

    it('应正确处理 Unicode 和 emoji 标题', async () => {
      const mockSessions: IFlowSessionMeta[] = [
        { sessionId: 's1', title: '你好世界 🌍 日本語', messageCount: 1, fileSize: 100, createdAt: '2026-03-19T10:00:00Z', updatedAt: '2026-03-19T11:00:00Z', inputTokens: 10, outputTokens: 20 },
      ]

      vi.mocked(invoke).mockResolvedValue(mockSessions)

      const result = await service.listSessions()

      expect(result[0].title).toBe('你好世界 🌍 日本語')
    })
  })

  // ===========================================================================
  // getSessionHistory 测试
  // ===========================================================================

  describe('getSessionHistory', () => {
    it('应正确返回会话历史消息', async () => {
      const mockMessages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'user',
          content: 'Hello',
          toolCalls: [],
        },
        {
          uuid: 'msg-2',
          parentUuid: 'msg-1',
          timestamp: '2026-03-19T10:01:00Z',
          type: 'assistant',
          content: 'Hi there!',
          model: 'gpt-4',
          stopReason: 'end_turn',
          inputTokens: 10,
          outputTokens: 20,
          toolCalls: [],
        },
      ]

      vi.mocked(invoke).mockResolvedValue(mockMessages)

      const result = await service.getSessionHistory('session-1')

      expect(result).toHaveLength(2)
      expect(result[0].uuid).toBe('msg-1')
      expect(result[0].type).toBe('user')
      expect(result[1].type).toBe('assistant')
      expect(invoke).toHaveBeenCalledWith('get_iflow_session_history', { sessionId: 'session-1' })
    })

    it('应返回空数组当没有历史时', async () => {
      vi.mocked(invoke).mockResolvedValue([])

      const result = await service.getSessionHistory('session-1')

      expect(result).toEqual([])
    })

    it('应在错误时返回空数组', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('Session not found'))

      const result = await service.getSessionHistory('invalid-session')

      expect(result).toEqual([])
    })

    it('应正确处理包含工具调用的消息', async () => {
      const mockMessages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-1', name: 'read_file', input: { path: '/test.txt' } },
            { id: 'tc-2', name: 'write_file', input: { path: '/output.txt', content: 'data' } },
          ],
        },
      ]

      vi.mocked(invoke).mockResolvedValue(mockMessages)

      const result = await service.getSessionHistory('session-1')

      expect(result).toHaveLength(1)
      expect(result[0].toolCalls).toHaveLength(2)
      expect(result[0].toolCalls[0].name).toBe('read_file')
    })

    it('应正确处理空工具调用数组', async () => {
      const mockMessages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'user',
          content: 'Test',
          toolCalls: [],
        },
      ]

      vi.mocked(invoke).mockResolvedValue(mockMessages)

      const result = await service.getSessionHistory('session-1')

      expect(result[0].toolCalls).toEqual([])
    })
  })

  // ===========================================================================
  // getFileContexts 测试
  // ===========================================================================

  describe('getFileContexts', () => {
    it('应正确返回文件上下文列表', async () => {
      const mockContexts = [
        {
          path: '/src/index.ts',
          fileType: 'file' as const,
          accessCount: 5,
          firstAccessed: '2026-03-19T09:00:00Z',
          lastAccessed: '2026-03-19T11:00:00Z',
        },
        {
          path: '/src/components',
          fileType: 'directory' as const,
          accessCount: 3,
          firstAccessed: '2026-03-19T09:00:00Z',
          lastAccessed: '2026-03-19T10:00:00Z',
        },
        {
          path: '/assets/logo.png',
          fileType: 'image' as const,
          accessCount: 1,
          firstAccessed: '2026-03-19T10:00:00Z',
          lastAccessed: '2026-03-19T10:00:00Z',
        },
      ]

      vi.mocked(invoke).mockResolvedValue(mockContexts)

      const result = await service.getFileContexts('session-1')

      expect(result).toHaveLength(3)
      expect(result[0].fileType).toBe('file')
      expect(result[1].fileType).toBe('directory')
      expect(result[2].fileType).toBe('image')
      expect(invoke).toHaveBeenCalledWith('get_iflow_file_contexts', { sessionId: 'session-1' })
    })

    it('应返回空数组当没有文件上下文时', async () => {
      vi.mocked(invoke).mockResolvedValue([])

      const result = await service.getFileContexts('session-1')

      expect(result).toEqual([])
    })

    it('应在错误时返回空数组', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('Failed to get contexts'))

      const result = await service.getFileContexts('session-1')

      expect(result).toEqual([])
    })
  })

  // ===========================================================================
  // getTokenStats 测试
  // ===========================================================================

  describe('getTokenStats', () => {
    it('应正确返回 Token 统计', async () => {
      const mockStats: IFlowTokenStats = {
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        totalTokens: 3000,
        messageCount: 10,
        userMessageCount: 5,
        assistantMessageCount: 5,
      }

      vi.mocked(invoke).mockResolvedValue(mockStats)

      const result = await service.getTokenStats('session-1')

      expect(result).not.toBeNull()
      expect(result?.totalTokens).toBe(3000)
      expect(result?.messageCount).toBe(10)
      expect(invoke).toHaveBeenCalledWith('get_iflow_token_stats', { sessionId: 'session-1' })
    })

    it('应返回 null 当后端返回 null 时', async () => {
      vi.mocked(invoke).mockResolvedValue(null)

      const result = await service.getTokenStats('session-1')

      expect(result).toBeNull()
    })

    it('应在错误时返回 null', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('Failed to get stats'))

      const result = await service.getTokenStats('session-1')

      expect(result).toBeNull()
    })

    it('应正确处理零值统计', async () => {
      const mockStats: IFlowTokenStats = {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        messageCount: 0,
        userMessageCount: 0,
        assistantMessageCount: 0,
      }

      vi.mocked(invoke).mockResolvedValue(mockStats)

      const result = await service.getTokenStats('empty-session')

      expect(result?.totalTokens).toBe(0)
      expect(result?.messageCount).toBe(0)
    })
  })

  // ===========================================================================
  // convertMessagesToFormat 测试
  // ===========================================================================

  describe('convertMessagesToFormat', () => {
    it('应正确转换用户消息', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'user',
          content: 'Hello world',
          toolCalls: [],
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('msg-1')
      expect(result[0].role).toBe('user')
      expect(result[0].content).toBe('Hello world')
      expect(result[0].timestamp).toBe('2026-03-19T10:00:00Z')
      expect(result[0].toolSummary).toBeUndefined()
    })

    it('应正确转换助手消息', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: 'Hi there!',
          model: 'gpt-4',
          toolCalls: [],
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result[0].role).toBe('assistant')
      expect(result[0].content).toBe('Hi there!')
    })

    it('应正确添加工具调用摘要', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-1', name: 'read_file', input: {} },
            { id: 'tc-2', name: 'write_file', input: {} },
            { id: 'tc-3', name: 'read_file', input: {} }, // 重复名称
          ],
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result[0].toolSummary).toBeDefined()
      expect(result[0].toolSummary?.count).toBe(3)
      // 名称应该去重
      expect(result[0].toolSummary?.names).toEqual(['read_file', 'write_file'])
    })

    it('应正确处理空消息数组', () => {
      const result = service.convertMessagesToFormat([])

      expect(result).toEqual([])
    })

    it('应正确处理多条消息', () => {
      const messages: IFlowHistoryMessage[] = [
        { uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'user', content: 'Q1', toolCalls: [] },
        { uuid: 'msg-2', timestamp: '2026-03-19T10:01:00Z', type: 'assistant', content: 'A1', toolCalls: [] },
        { uuid: 'msg-3', timestamp: '2026-03-19T10:02:00Z', type: 'user', content: 'Q2', toolCalls: [] },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result).toHaveLength(3)
    })
  })

  // ===========================================================================
  // extractToolCalls 测试
  // ===========================================================================

  describe('extractToolCalls', () => {
    it('应正确提取工具调用', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-1', name: 'read_file', input: { path: '/test.txt' } },
          ],
        },
        {
          uuid: 'msg-2',
          timestamp: '2026-03-19T10:01:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-2', name: 'write_file', input: { path: '/out.txt', content: 'data' } },
          ],
        },
      ]

      const result = service.extractToolCalls(messages)

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('tc-1')
      expect(result[0].name).toBe('read_file')
      expect(result[0].status).toBe('completed')
      expect(result[0].input).toEqual({ path: '/test.txt' })
      expect(result[0].startedAt).toBe('2026-03-19T10:00:00Z')
    })

    it('应返回空数组当没有工具调用时', () => {
      const messages: IFlowHistoryMessage[] = [
        { uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'user', content: 'Hello', toolCalls: [] },
      ]

      const result = service.extractToolCalls(messages)

      expect(result).toEqual([])
    })

    it('应正确处理空消息数组', () => {
      const result = service.extractToolCalls([])

      expect(result).toEqual([])
    })

    it('应正确处理多条消息中的多个工具调用', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-1', name: 'tool1', input: { a: 1 } },
            { id: 'tc-2', name: 'tool2', input: { b: 2 } },
          ],
        },
        {
          uuid: 'msg-2',
          timestamp: '2026-03-19T10:01:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-3', name: 'tool3', input: { c: 3 } },
          ],
        },
      ]

      const result = service.extractToolCalls(messages)

      expect(result).toHaveLength(3)
    })
  })

  // ===========================================================================
  // generateSessionTitle 测试
  // ===========================================================================

  describe('generateSessionTitle', () => {
    it('应使用第一条用户消息生成标题', () => {
      const messages: IFlowHistoryMessage[] = [
        { uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'assistant', content: 'Hi', toolCalls: [] },
        { uuid: 'msg-2', timestamp: '2026-03-19T10:01:00Z', type: 'user', content: 'This is my question', toolCalls: [] },
      ]

      const result = service.generateSessionTitle(messages)

      expect(result).toBe('This is my question')
    })

    it('应截断过长的标题', () => {
      const longContent = 'A'.repeat(100)
      const messages: IFlowHistoryMessage[] = [
        { uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'user', content: longContent, toolCalls: [] },
      ]

      const result = service.generateSessionTitle(messages)

      expect(result.length).toBe(53) // 50 + '...'
      expect(result.endsWith('...')).toBe(true)
    })

    it('应返回默认标题当没有用户消息时', () => {
      const messages: IFlowHistoryMessage[] = [
        { uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'assistant', content: 'Hello', toolCalls: [] },
      ]

      const result = service.generateSessionTitle(messages)

      expect(result).toBe('IFlow 对话')
    })

    it('应返回默认标题当消息为空时', () => {
      const result = service.generateSessionTitle([])

      expect(result).toBe('IFlow 对话')
    })

    it('应返回默认标题当用户消息内容为空时', () => {
      const messages: IFlowHistoryMessage[] = [
        { uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'user', content: '', toolCalls: [] },
      ]

      const result = service.generateSessionTitle(messages)

      expect(result).toBe('IFlow 对话')
    })

    it('应返回默认标题当用户消息内容只有空格时', () => {
      const messages: IFlowHistoryMessage[] = [
        { uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'user', content: '   ', toolCalls: [] },
      ]

      const result = service.generateSessionTitle(messages)

      expect(result).toBe('IFlow 对话')
    })

    it('应正确处理刚好 50 字符的内容', () => {
      const content = 'A'.repeat(50)
      const messages: IFlowHistoryMessage[] = [
        { uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'user', content, toolCalls: [] },
      ]

      const result = service.generateSessionTitle(messages)

      expect(result).toBe(content)
      expect(result.length).toBe(50)
    })

    it('应正确处理刚好 51 字符的内容', () => {
      const content = 'A'.repeat(51)
      const messages: IFlowHistoryMessage[] = [
        { uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'user', content, toolCalls: [] },
      ]

      const result = service.generateSessionTitle(messages)

      expect(result.endsWith('...')).toBe(true)
    })
  })

  // ===========================================================================
  // getSessionSummary 测试
  // ===========================================================================

  describe('getSessionSummary', () => {
    const mockMeta: IFlowSessionMeta = {
      sessionId: 'session-1',
      title: 'Test',
      messageCount: 10,
      fileSize: 1024,
      createdAt: '2026-03-19T10:00:00Z',
      updatedAt: '2026-03-19T11:00:00Z',
      inputTokens: 100,
      outputTokens: 200,
    }

    it('应生成基本摘要', () => {
      // inputTokens 和 outputTokens 都为 0 时不显示 Token
      const metaNoTokens: IFlowSessionMeta = {
        ...mockMeta,
        inputTokens: 0,
        outputTokens: 0,
      }
      const result = service.getSessionSummary(metaNoTokens)

      expect(result).toBe('10 条消息')
    })

    it('应包含 Token 统计当有 stats 时', () => {
      const stats: IFlowTokenStats = {
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalTokens: 300,
        messageCount: 10,
        userMessageCount: 5,
        assistantMessageCount: 5,
      }

      const result = service.getSessionSummary(mockMeta, stats)

      expect(result).toBe('10 条消息 · 300 Tokens')
    })

    it('应使用 meta 中的 Token 当没有 stats 时', () => {
      const result = service.getSessionSummary(mockMeta, null)

      expect(result).toBe('10 条消息 · 300 Tokens')
    })

    it('应正确处理零 Token', () => {
      const metaNoTokens: IFlowSessionMeta = {
        ...mockMeta,
        inputTokens: 0,
        outputTokens: 0,
      }

      const result = service.getSessionSummary(metaNoTokens, null)

      expect(result).toBe('10 条消息')
    })

    it('应正确格式化大数值 Token', () => {
      const stats: IFlowTokenStats = {
        totalInputTokens: 1000000,
        totalOutputTokens: 2000000,
        totalTokens: 3000000,
        messageCount: 100,
        userMessageCount: 50,
        assistantMessageCount: 50,
      }

      const result = service.getSessionSummary(mockMeta, stats)

      expect(result).toContain('3,000,000 Tokens')
    })

    it('应优先使用 stats 中的 Token', () => {
      const metaWithTokens: IFlowSessionMeta = {
        ...mockMeta,
        inputTokens: 50,
        outputTokens: 50,
      }
      const stats: IFlowTokenStats = {
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalTokens: 300,
        messageCount: 10,
        userMessageCount: 5,
        assistantMessageCount: 5,
      }

      const result = service.getSessionSummary(metaWithTokens, stats)

      expect(result).toContain('300 Tokens')
    })
  })

  // ===========================================================================
  // formatFileSize 测试
  // ===========================================================================

  describe('formatFileSize', () => {
    it('应正确处理 0 字节', () => {
      expect(service.formatFileSize(0)).toBe('0 B')
    })

    it('应正确格式化字节', () => {
      expect(service.formatFileSize(512)).toBe('512 B')
    })

    it('应正确格式化 KB', () => {
      expect(service.formatFileSize(1024)).toBe('1 KB')
      expect(service.formatFileSize(2048)).toBe('2 KB')
      expect(service.formatFileSize(1536)).toBe('1.5 KB')
    })

    it('应正确格式化 MB', () => {
      expect(service.formatFileSize(1048576)).toBe('1 MB')
      expect(service.formatFileSize(1572864)).toBe('1.5 MB')
      expect(service.formatFileSize(10485760)).toBe('10 MB')
    })

    it('应正确格式化 GB', () => {
      expect(service.formatFileSize(1073741824)).toBe('1 GB')
      expect(service.formatFileSize(5368709120)).toBe('5 GB')
    })

    it('应正确处理边界值', () => {
      expect(service.formatFileSize(1)).toBe('1 B')
      expect(service.formatFileSize(1023)).toBe('1023 B')
      expect(service.formatFileSize(1025)).toBe('1 KB')
    })
  })

  // ===========================================================================
  // formatTime 测试
  // ===========================================================================

  describe('formatTime', () => {
    it('应返回 "刚刚" 对于小于 1 分钟', () => {
      const now = new Date().toISOString()
      expect(service.formatTime(now)).toBe('刚刚')
    })

    it('应返回分钟数对于小于 1 小时', () => {
      const date = new Date(Date.now() - 5 * 60000)
      expect(service.formatTime(date.toISOString())).toBe('5 分钟前')
    })

    it('应返回小时数对于小于 24 小时', () => {
      const date = new Date(Date.now() - 3 * 3600000)
      expect(service.formatTime(date.toISOString())).toBe('3 小时前')
    })

    it('应返回天数对于小于 7 天', () => {
      const date = new Date(Date.now() - 3 * 86400000)
      expect(service.formatTime(date.toISOString())).toBe('3 天前')
    })

    it('应返回日期格式对于超过 7 天', () => {
      const date = new Date(Date.now() - 10 * 86400000)
      const result = service.formatTime(date.toISOString())
      expect(result).toMatch(/\d+月\d+/)
    })

    it('应正确处理去年日期（超过 7 天）', () => {
      const lastYear = new Date()
      lastYear.setFullYear(lastYear.getFullYear() - 1)
      const result = service.formatTime(lastYear.toISOString())
      // formatTime 对于超过 7 天的日期只返回"月日"格式
      expect(result).toMatch(/\d+月\d+日/)
    })
  })

  // ===========================================================================
  // 单例模式测试
  // ===========================================================================

  describe('单例模式', () => {
    it('getIFlowHistoryService 应返回单例', () => {
      resetIFlowHistoryService()
      const instance1 = getIFlowHistoryService()
      const instance2 = getIFlowHistoryService()
      expect(instance1).toBe(instance2)
    })

    it('resetIFlowHistoryService 应重置单例', () => {
      resetIFlowHistoryService()
      const instance1 = getIFlowHistoryService()
      resetIFlowHistoryService()
      const instance2 = getIFlowHistoryService()
      expect(instance1).not.toBe(instance2)
    })
  })

  // ===========================================================================
  // 边界值完整性测试
  // ===========================================================================

  describe('formatFileSize 边界值完整性', () => {
    it('应正确处理负数字节', () => {
      const result = service.formatFileSize(-1)
      expect(typeof result).toBe('string')
    })

    it('应正确处理小数字节', () => {
      const result = service.formatFileSize(0.5)
      expect(typeof result).toBe('string')
    })

    it('应正确处理非常大的数值', () => {
      const result = service.formatFileSize(1099511627776) // 1 TB
      expect(typeof result).toBe('string')
    })
  })

  describe('formatTime 边界值完整性', () => {
    it('应正确处理未来日期', () => {
      const futureDate = new Date(Date.now() + 3600000)
      const result = service.formatTime(futureDate.toISOString())
      expect(['刚刚', expect.stringMatching(/-\d+ 分钟前/)]).toContain(result)
    })

    it('应正确处理刚好 1 分钟边界', () => {
      const date = new Date(Date.now() - 60000)
      expect(service.formatTime(date.toISOString())).toBe('1 分钟前')
    })

    it('应正确处理刚好 1 小时边界', () => {
      const date = new Date(Date.now() - 3600000)
      expect(service.formatTime(date.toISOString())).toBe('1 小时前')
    })

    it('应正确处理刚好 24 小时边界', () => {
      const date = new Date(Date.now() - 86400000)
      expect(service.formatTime(date.toISOString())).toBe('1 天前')
    })

    it('应正确处理刚好 7 天边界', () => {
      const date = new Date(Date.now() - 7 * 86400000)
      const result = service.formatTime(date.toISOString())
      expect(result).toMatch(/\d+月\d+/)
    })

    it('应正确处理无效日期字符串', () => {
      const result = service.formatTime('invalid-date')
      expect(typeof result).toBe('string')
    })

    it('应正确处理空字符串日期', () => {
      const result = service.formatTime('')
      expect(typeof result).toBe('string')
    })
  })

  // ===========================================================================
  // 并发测试
  // ===========================================================================

  describe('并发安全性', () => {
    it('应正确处理并发 listSessions 调用', async () => {
      const mockSessions: IFlowSessionMeta[] = [
        { sessionId: 's1', title: 'Session 1', messageCount: 1, fileSize: 100, createdAt: '2026-03-19T10:00:00Z', updatedAt: '2026-03-19T11:00:00Z', inputTokens: 10, outputTokens: 20 },
      ]

      vi.mocked(invoke).mockResolvedValue(mockSessions)

      const results = await Promise.all([
        service.listSessions(),
        service.listSessions(),
        service.listSessions(),
      ])

      expect(results[0]).toEqual(results[1])
      expect(results[1]).toEqual(results[2])
    })

    it('应正确处理并发 getSessionHistory 调用', async () => {
      const mockMessages: IFlowHistoryMessage[] = [
        { uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'user', content: 'Hello', toolCalls: [] },
      ]

      vi.mocked(invoke).mockResolvedValue(mockMessages)

      const results = await Promise.all([
        service.getSessionHistory('session-1'),
        service.getSessionHistory('session-2'),
        service.getSessionHistory('session-3'),
      ])

      expect(results[0]).toHaveLength(1)
      expect(results[1]).toHaveLength(1)
      expect(results[2]).toHaveLength(1)
    })

    it('应正确处理并发 getFileContexts 调用', async () => {
      const mockContexts = [
        { path: '/test.ts', fileType: 'file' as const, accessCount: 1, firstAccessed: '2026-03-19T10:00:00Z', lastAccessed: '2026-03-19T11:00:00Z' },
      ]

      vi.mocked(invoke).mockResolvedValue(mockContexts)

      const results = await Promise.all([
        service.getFileContexts('session-1'),
        service.getFileContexts('session-2'),
      ])

      expect(results[0]).toHaveLength(1)
      expect(results[1]).toHaveLength(1)
    })

    it('应正确处理并发 getTokenStats 调用', async () => {
      const mockStats: IFlowTokenStats = {
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalTokens: 300,
        messageCount: 10,
        userMessageCount: 5,
        assistantMessageCount: 5,
      }

      vi.mocked(invoke).mockResolvedValue(mockStats)

      const results = await Promise.all([
        service.getTokenStats('session-1'),
        service.getTokenStats('session-2'),
      ])

      expect(results[0]?.totalTokens).toBe(300)
      expect(results[1]?.totalTokens).toBe(300)
    })

    it('应正确处理混合并发调用', async () => {
      const mockSessions: IFlowSessionMeta[] = [
        { sessionId: 's1', title: 'Session', messageCount: 1, fileSize: 100, createdAt: '2026-03-19T10:00:00Z', updatedAt: '2026-03-19T11:00:00Z', inputTokens: 10, outputTokens: 20 },
      ]
      const mockMessages: IFlowHistoryMessage[] = [
        { uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'user', content: 'Test', toolCalls: [] },
      ]
      const mockContexts = [
        { path: '/test.ts', fileType: 'file' as const, accessCount: 1, firstAccessed: '2026-03-19T10:00:00Z', lastAccessed: '2026-03-19T11:00:00Z' },
      ]
      const mockStats: IFlowTokenStats = {
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalTokens: 300,
        messageCount: 10,
        userMessageCount: 5,
        assistantMessageCount: 5,
      }

      let callCount = 0
      vi.mocked(invoke).mockImplementation(async () => {
        callCount++
        if (callCount === 1) return mockSessions
        if (callCount === 2) return mockMessages
        if (callCount === 3) return mockContexts
        return mockStats
      })

      const [sessions, history, contexts, stats] = await Promise.all([
        service.listSessions(),
        service.getSessionHistory('session-1'),
        service.getFileContexts('session-1'),
        service.getTokenStats('session-1'),
      ])

      expect(sessions).toHaveLength(1)
      expect(history).toHaveLength(1)
      expect(contexts).toHaveLength(1)
      expect(stats?.totalTokens).toBe(300)
    })
  })

  // ===========================================================================
  // 数据一致性测试
  // ===========================================================================

  describe('数据一致性', () => {
    it('listSessions 多次调用应返回相同结果', async () => {
      const mockSessions: IFlowSessionMeta[] = [
        { sessionId: 's1', title: 'Session', messageCount: 1, fileSize: 100, createdAt: '2026-03-19T10:00:00Z', updatedAt: '2026-03-19T11:00:00Z', inputTokens: 10, outputTokens: 20 },
      ]

      vi.mocked(invoke).mockResolvedValue(mockSessions)

      const result1 = await service.listSessions()
      const result2 = await service.listSessions()

      expect(result1).toEqual(result2)
    })

    it('getSessionHistory 多次调用应返回相同结果', async () => {
      const mockMessages: IFlowHistoryMessage[] = [
        { uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'user', content: 'Test', toolCalls: [] },
      ]

      vi.mocked(invoke).mockResolvedValue(mockMessages)

      const result1 = await service.getSessionHistory('session-1')
      const result2 = await service.getSessionHistory('session-1')

      expect(result1).toEqual(result2)
    })

    it('convertMessagesToFormat 应保持数据完整性', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'user',
          content: 'Test content with special chars: <>&"\'',
          toolCalls: [],
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result[0].content).toBe('Test content with special chars: <>&"\'')
    })

    it('extractToolCalls 应保持工具调用顺序', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-1', name: 'tool_a', input: {} },
            { id: 'tc-2', name: 'tool_b', input: {} },
            { id: 'tc-3', name: 'tool_c', input: {} },
          ],
        },
      ]

      const result = service.extractToolCalls(messages)

      expect(result[0].name).toBe('tool_a')
      expect(result[1].name).toBe('tool_b')
      expect(result[2].name).toBe('tool_c')
    })
  })

  // ===========================================================================
  // 错误恢复测试
  // ===========================================================================

  describe('错误恢复', () => {
    it('listSessions 网络错误后应能恢复', async () => {
      vi.mocked(invoke)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce([{ sessionId: 's1', title: 'Recovered', messageCount: 1, fileSize: 100, createdAt: '2026-03-19T10:00:00Z', updatedAt: '2026-03-19T11:00:00Z', inputTokens: 10, outputTokens: 20 }])

      const result1 = await service.listSessions()
      expect(result1).toEqual([])

      const result2 = await service.listSessions()
      expect(result2).toHaveLength(1)
      expect(result2[0].title).toBe('Recovered')
    })

    it('getSessionHistory 会话不存在后应能获取其他会话', async () => {
      vi.mocked(invoke)
        .mockRejectedValueOnce(new Error('Session not found'))
        .mockResolvedValueOnce([{ uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'user', content: 'Test', toolCalls: [] }])

      const result1 = await service.getSessionHistory('invalid')
      expect(result1).toEqual([])

      const result2 = await service.getSessionHistory('valid')
      expect(result2).toHaveLength(1)
    })

    it('getTokenStats 部分失败场景', async () => {
      vi.mocked(invoke)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          totalInputTokens: 100,
          totalOutputTokens: 200,
          totalTokens: 300,
          messageCount: 10,
          userMessageCount: 5,
          assistantMessageCount: 5,
        })

      const result1 = await service.getTokenStats('session-1')
      expect(result1).toBeNull()

      const result2 = await service.getTokenStats('session-2')
      expect(result2?.totalTokens).toBe(300)
    })
  })

  // ===========================================================================
  // 复杂场景测试
  // ===========================================================================

  describe('复杂消息场景', () => {
    it('应正确处理嵌套工具调用输入', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'tc-1',
              name: 'run_command',
              input: {
                command: 'npm',
                args: ['test', '--coverage'],
                env: { NODE_ENV: 'test' },
              },
            },
          ],
        },
      ]

      const result = service.extractToolCalls(messages)

      expect(result[0].input).toEqual({
        command: 'npm',
        args: ['test', '--coverage'],
        env: { NODE_ENV: 'test' },
      })
    })

    it('应正确处理包含代码块的消息', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '这是代码示例：\n```typescript\nconst x = 1;\n```',
          toolCalls: [],
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result[0].content).toContain('```typescript')
    })

    it('应正确处理超长消息内容', () => {
      const longContent = 'A'.repeat(100000)
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'user',
          content: longContent,
          toolCalls: [],
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result[0].content).toBe(longContent)
      expect(result[0].content.length).toBe(100000)
    })

    it('应正确处理 parentUuid 链式关系', async () => {
      const mockMessages: IFlowHistoryMessage[] = [
        { uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'user', content: 'Q1', toolCalls: [] },
        { uuid: 'msg-2', parentUuid: 'msg-1', timestamp: '2026-03-19T10:01:00Z', type: 'assistant', content: 'A1', toolCalls: [] },
        { uuid: 'msg-3', parentUuid: 'msg-2', timestamp: '2026-03-19T10:02:00Z', type: 'user', content: 'Q2', toolCalls: [] },
      ]

      vi.mocked(invoke).mockResolvedValue(mockMessages)

      const result = await service.getSessionHistory('session-1')

      expect(result).toHaveLength(3)
      expect(result[1].parentUuid).toBe('msg-1')
      expect(result[2].parentUuid).toBe('msg-2')
    })

    it('应正确处理多条工具调用的去重', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-1', name: 'read_file', input: {} },
            { id: 'tc-2', name: 'read_file', input: {} },
            { id: 'tc-3', name: 'read_file', input: {} },
          ],
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result[0].toolSummary?.count).toBe(3)
      expect(result[0].toolSummary?.names).toEqual(['read_file'])
    })
  })

  // ===========================================================================
  // 大量数据性能测试
  // ===========================================================================

  describe('大量数据处理', () => {
    it('应正确处理 100 个会话', async () => {
      const mockSessions: IFlowSessionMeta[] = Array.from({ length: 100 }, (_, i) => ({
        sessionId: `session-${i}`,
        title: `Session ${i}`,
        messageCount: i + 1,
        fileSize: (i + 1) * 1024,
        createdAt: '2026-03-19T10:00:00Z',
        updatedAt: '2026-03-19T11:00:00Z',
        inputTokens: (i + 1) * 10,
        outputTokens: (i + 1) * 20,
      }))

      vi.mocked(invoke).mockResolvedValue(mockSessions)

      const result = await service.listSessions()

      expect(result).toHaveLength(100)
    })

    it('应正确处理 1000 条消息', async () => {
      const mockMessages: IFlowHistoryMessage[] = Array.from({ length: 1000 }, (_, i) => ({
        uuid: `msg-${i}`,
        timestamp: '2026-03-19T10:00:00Z',
        type: i % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `Message ${i}`,
        toolCalls: [],
      }))

      vi.mocked(invoke).mockResolvedValue(mockMessages)

      const result = await service.getSessionHistory('session-1')

      expect(result).toHaveLength(1000)
    })

    it('应正确转换 500 条消息', () => {
      const messages: IFlowHistoryMessage[] = Array.from({ length: 500 }, (_, i) => ({
        uuid: `msg-${i}`,
        timestamp: '2026-03-19T10:00:00Z',
        type: i % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `Content ${i}`,
        toolCalls: [],
      }))

      const result = service.convertMessagesToFormat(messages)

      expect(result).toHaveLength(500)
    })
  })

  // ===========================================================================
  // 类型安全测试
  // ===========================================================================

  describe('类型安全', () => {
    it('getSessionHistory 应正确处理 undefined parentUuid', async () => {
      const mockMessages: IFlowHistoryMessage[] = [
        { uuid: 'msg-1', timestamp: '2026-03-19T10:00:00Z', type: 'user', content: 'Test', toolCalls: [] },
      ]

      vi.mocked(invoke).mockResolvedValue(mockMessages)

      const result = await service.getSessionHistory('session-1')

      expect(result[0].parentUuid).toBeUndefined()
    })

    it('convertMessagesToFormat 应正确处理缺少可选字段', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: 'Test',
          toolCalls: [],
          // 缺少 model, stopReason, inputTokens, outputTokens, parentUuid
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result[0].id).toBe('msg-1')
      expect(result[0].role).toBe('assistant')
    })

    it('extractToolCalls 应正确处理 input 为复杂对象', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'tc-1',
              name: 'complex_tool',
              input: {
                nested: {
                  deep: {
                    value: 123,
                    array: [1, 2, 3],
                  },
                },
                nullValue: null,
                boolValue: true,
              },
            },
          ],
        },
      ]

      const result = service.extractToolCalls(messages)

      expect((result[0].input as Record<string, unknown>).nested).toBeDefined()
    })

    it('convertMessagesToFormat toolSummary 应正确处理空名称数组', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: 'Test',
          toolCalls: [],
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result[0].toolSummary).toBeUndefined()
    })
  })

  // ===========================================================================
  // 特殊日期格式测试
  // ===========================================================================

  describe('formatTime 特殊日期格式', () => {
    it('应正确处理 ISO 8601 格式', () => {
      const result = service.formatTime('2026-03-19T10:00:00.000Z')
      expect(typeof result).toBe('string')
    })

    it('应正确处理带时区的日期', () => {
      const result = service.formatTime('2026-03-19T18:00:00+08:00')
      expect(typeof result).toBe('string')
    })

    it('应正确处理 UTC 格式', () => {
      const result = service.formatTime('2026-03-19T10:00:00Z')
      expect(typeof result).toBe('string')
    })

    it('应正确处理简短日期格式', () => {
      const result = service.formatTime('2026-03-19')
      expect(typeof result).toBe('string')
    })

    it('应正确处理带毫秒的日期', () => {
      const result = service.formatTime('2026-03-19T10:00:00.123456Z')
      expect(typeof result).toBe('string')
    })

    it('应正确处理跨年日期', () => {
      const lastYear = new Date()
      lastYear.setFullYear(lastYear.getFullYear() - 2)
      const result = service.formatTime(lastYear.toISOString())
      expect(result).toMatch(/\d+月\d+日/)
    })
  })

  // ===========================================================================
  // 极端数值测试
  // ===========================================================================

  describe('极端数值处理', () => {
    it('formatFileSize 应正确处理 Number.MAX_SAFE_INTEGER', () => {
      const result = service.formatFileSize(Number.MAX_SAFE_INTEGER)
      expect(typeof result).toBe('string')
    })

    it('formatFileSize 应正确处理 Number.MIN_VALUE', () => {
      const result = service.formatFileSize(Number.MIN_VALUE)
      expect(typeof result).toBe('string')
    })

    it('formatFileSize 应正确处理 NaN', () => {
      const result = service.formatFileSize(NaN)
      expect(typeof result).toBe('string')
    })

    it('formatFileSize 应正确处理 Infinity', () => {
      const result = service.formatFileSize(Infinity)
      expect(typeof result).toBe('string')
    })

    it('getSessionSummary 应正确处理极大 Token 数', () => {
      const meta: IFlowSessionMeta = {
        sessionId: 's1',
        title: 'Test',
        messageCount: 999999,
        fileSize: 999999999,
        createdAt: '2026-03-19T10:00:00Z',
        updatedAt: '2026-03-19T11:00:00Z',
        inputTokens: 999999999,
        outputTokens: 999999999,
      }

      const result = service.getSessionSummary(meta, null)

      // 使用正则匹配避免 toLocaleString 格式差异
      expect(result).toMatch(/999999 条消息/)
      expect(result).toMatch(/\d[\d,]* Tokens/)
    })

    it('getTokenStats 应正确处理极端统计值', async () => {
      const mockStats: IFlowTokenStats = {
        totalInputTokens: Number.MAX_SAFE_INTEGER,
        totalOutputTokens: Number.MAX_SAFE_INTEGER,
        totalTokens: Number.MAX_SAFE_INTEGER,
        messageCount: Number.MAX_SAFE_INTEGER,
        userMessageCount: Number.MAX_SAFE_INTEGER,
        assistantMessageCount: Number.MAX_SAFE_INTEGER,
      }

      vi.mocked(invoke).mockResolvedValue(mockStats)

      const result = await service.getTokenStats('session-1')

      expect(result?.totalTokens).toBe(Number.MAX_SAFE_INTEGER)
    })
  })

  // ===========================================================================
  // 输入验证测试
  // ===========================================================================

  describe('输入验证', () => {
    it('listSessions 应正确处理返回 null', async () => {
      vi.mocked(invoke).mockResolvedValue(null)

      const result = await service.listSessions()

      expect(result).toEqual([])
    })

    it('listSessions 应正确处理返回 undefined', async () => {
      vi.mocked(invoke).mockResolvedValue(undefined)

      const result = await service.listSessions()

      expect(result).toEqual([])
    })

    it('getSessionHistory 应正确处理返回 null', async () => {
      vi.mocked(invoke).mockResolvedValue(null)

      const result = await service.getSessionHistory('session-1')

      expect(result).toEqual([])
    })

    it('getFileContexts 应正确处理返回 null', async () => {
      vi.mocked(invoke).mockResolvedValue(null)

      const result = await service.getFileContexts('session-1')

      expect(result).toEqual([])
    })

    it('getSessionHistory 应正确处理空 sessionId', async () => {
      vi.mocked(invoke).mockResolvedValue([])

      const result = await service.getSessionHistory('')

      expect(result).toEqual([])
      expect(invoke).toHaveBeenCalledWith('get_iflow_session_history', { sessionId: '' })
    })

    it('getFileContexts 应正确处理空 sessionId', async () => {
      vi.mocked(invoke).mockResolvedValue([])

      const result = await service.getFileContexts('')

      expect(result).toEqual([])
      expect(invoke).toHaveBeenCalledWith('get_iflow_file_contexts', { sessionId: '' })
    })

    it('getTokenStats 应正确处理空 sessionId', async () => {
      vi.mocked(invoke).mockResolvedValue(null)

      const result = await service.getTokenStats('')

      expect(result).toBeNull()
      expect(invoke).toHaveBeenCalledWith('get_iflow_token_stats', { sessionId: '' })
    })
  })

  // ===========================================================================
  // 服务实例方法完整性测试
  // ===========================================================================

  describe('服务实例方法完整性', () => {
    it('服务应包含所有必需的异步方法', () => {
      expect(typeof service.listSessions).toBe('function')
      expect(typeof service.getSessionHistory).toBe('function')
      expect(typeof service.getFileContexts).toBe('function')
      expect(typeof service.getTokenStats).toBe('function')
    })

    it('服务应包含所有必需的同步方法', () => {
      expect(typeof service.convertMessagesToFormat).toBe('function')
      expect(typeof service.extractToolCalls).toBe('function')
      expect(typeof service.generateSessionTitle).toBe('function')
      expect(typeof service.getSessionSummary).toBe('function')
      expect(typeof service.formatFileSize).toBe('function')
      expect(typeof service.formatTime).toBe('function')
    })

    it('getIFlowHistoryService 应返回 IFlowHistoryService 实例', () => {
      resetIFlowHistoryService()
      const instance = getIFlowHistoryService()
      expect(instance).toBeInstanceOf(IFlowHistoryService)
    })

    it('多次 getIFlowHistoryService 应返回同一实例', () => {
      resetIFlowHistoryService()
      const instance1 = getIFlowHistoryService()
      const instance2 = getIFlowHistoryService()
      expect(instance1).toBe(instance2)
    })
  })

  // ===========================================================================
  // 消息内容特殊字符测试
  // ===========================================================================

  describe('消息内容特殊字符', () => {
    it('应正确处理包含 HTML 标签的内容', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'user',
          content: '<div>Hello</div><script>alert(1)</script>',
          toolCalls: [],
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result[0].content).toBe('<div>Hello</div><script>alert(1)</script>')
    })

    it('应正确处理包含 JSON 字符串的内容', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '{"key": "value", "nested": {"a": 1}}',
          toolCalls: [],
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result[0].content).toContain('{"key"')
    })

    it('应正确处理包含换行符的内容', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'user',
          content: 'Line 1\nLine 2\r\nLine 3',
          toolCalls: [],
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result[0].content).toBe('Line 1\nLine 2\r\nLine 3')
    })

    it('应正确处理包含制表符的内容', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: 'Column 1\tColumn 2\tColumn 3',
          toolCalls: [],
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result[0].content).toBe('Column 1\tColumn 2\tColumn 3')
    })

    it('应正确处理包含特殊 Unicode 字符的内容', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'user',
          content: 'Special: \u0000\u0001\u0002\u0003',
          toolCalls: [],
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result[0].content).toBe('Special: \u0000\u0001\u0002\u0003')
    })
  })

  // ===========================================================================
  // 工具调用特殊场景测试
  // ===========================================================================

  describe('工具调用特殊场景', () => {
    it('应正确处理空对象 input', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-1', name: 'noop', input: {} },
          ],
        },
      ]

      const result = service.extractToolCalls(messages)

      expect(result[0].input).toEqual({})
    })

    it('应正确处理 null input', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-1', name: 'noop', input: null },
          ],
        },
      ]

      const result = service.extractToolCalls(messages)

      expect(result[0].input).toBeNull()
    })

    it('应正确处理数组 input', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-1', name: 'batch', input: [1, 2, 3, 'a', 'b', 'c'] },
          ],
        },
      ]

      const result = service.extractToolCalls(messages)

      expect(result[0].input).toEqual([1, 2, 3, 'a', 'b', 'c'])
    })

    it('应正确处理字符串 input', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-1', name: 'echo', input: 'simple string input' },
          ],
        },
      ]

      const result = service.extractToolCalls(messages)

      expect(result[0].input).toBe('simple string input')
    })

    it('应正确处理多个工具调用', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-1', name: 'echo', input: 'simple string' },
            { id: 'tc-2', name: 'echo', input: 'another string' },
          ],
        },
      ]

      const result = service.extractToolCalls(messages)

      expect(result).toHaveLength(2)
    })

    it('应正确处理数字 input', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-1', name: 'calculate', input: 42 },
          ],
        },
      ]

      const result = service.extractToolCalls(messages)

      expect(result[0].input).toBe(42)
    })

    it('应正确处理包含特殊字符的工具名称', () => {
      const messages: IFlowHistoryMessage[] = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00Z',
          type: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc-1', name: 'tool-with-dash', input: {} },
            { id: 'tc-2', name: 'tool_with_underscore', input: {} },
            { id: 'tc-3', name: 'tool.with.dot', input: {} },
          ],
        },
      ]

      const result = service.convertMessagesToFormat(messages)

      expect(result[0].toolSummary?.names).toEqual(['tool-with-dash', 'tool_with_underscore', 'tool.with.dot'])
    })
  })
})
