/**
 * utils.ts 单元测试
 *
 * 测试文件读取缓存和 AIEvent 事件处理器
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock Tauri invoke
const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}))

// 不再需要 mock toolPanelStore 和 gitStore，因为现在使用依赖注入模式

// Mock diffExtractor
vi.mock('../../utils/diffExtractor', () => ({
  extractEditDiff: vi.fn(() => null),
  isEditTool: vi.fn((toolName: string) => 
    toolName === 'Edit' || toolName === 'edit_file' || toolName === 'write_to_file'
  ),
}))

// 导入被测试模块
import {
  readFileWithCache,
  clearFileReadCache,
  handleAIEvent,
} from './utils'
import type { AIEvent } from '../../ai-runtime'
import type { EventChatState } from './types'

// Mock 依赖注入的 actions
const mockClearTools = vi.fn()
const mockAddTool = vi.fn()
const mockUpdateTool = vi.fn()
const mockRefreshStatusDebounced = vi.fn()

// 创建 mock store 函数
function createMockStoreSet() {
  const state: any = {
    conversationId: null,
    isStreaming: false,
    progressMessage: null,
    error: null,
    currentMessage: null,
    toolBlockMap: new Map(),
    questionBlockMap: new Map(),
    planBlockMap: new Map(),
    agentRunBlockMap: new Map(),
    activePlanId: null,
    activeTaskId: null,
    messages: [],
  }

  const set = vi.fn((partial: any) => {
    if (typeof partial === 'function') {
      const result = partial(state)
      Object.assign(state, result)
    } else {
      Object.assign(state, partial)
    }
  })

  const get = () => state

  // 添加依赖注入方法
  state.getToolPanelActions = () => ({
    clearTools: mockClearTools,
    addTool: mockAddTool,
    updateTool: mockUpdateTool,
  })

  state.getGitActions = () => ({
    refreshStatusDebounced: (...args: any[]) => {
      mockRefreshStatusDebounced(...args)
      return Promise.resolve()
    },
  })

  return { set, get, state }
}

describe('readFileWithCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearFileReadCache()
  })

  it('应调用 Tauri invoke 读取文件', async () => {
    mockInvoke.mockResolvedValueOnce('file content')

    const result = await readFileWithCache('/test/file.ts')

    expect(mockInvoke).toHaveBeenCalledWith('read_file_absolute', { path: '/test/file.ts' })
    expect(result).toBe('file content')
  })

  it('同一文件应缓存 Promise 避免重复读取', async () => {
    mockInvoke.mockImplementation(() => 
      new Promise(resolve => setTimeout(() => resolve('content'), 100))
    )

    // 同时发起两个读取请求
    const promise1 = readFileWithCache('/test/file.ts')
    const promise2 = readFileWithCache('/test/file.ts')

    // 应该只调用一次 invoke
    expect(mockInvoke).toHaveBeenCalledTimes(1)

    // 两个 Promise 应该相同
    expect(promise1).toBe(promise2)

    const [result1, result2] = await Promise.all([promise1, promise2])
    expect(result1).toBe('content')
    expect(result2).toBe('content')
  })

  it('读取完成后应清理缓存', async () => {
    mockInvoke.mockResolvedValueOnce('content')

    await readFileWithCache('/test/file.ts')

    // 再次读取应该创建新的 Promise
    mockInvoke.mockResolvedValueOnce('new content')
    await readFileWithCache('/test/file.ts')

    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('读取失败也应清理缓存', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('read error'))

    await expect(readFileWithCache('/test/file.ts')).rejects.toThrow('read error')

    // 缓存应该被清理，再次读取会创建新 Promise
    mockInvoke.mockResolvedValueOnce('content')
    await readFileWithCache('/test/file.ts')

    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })
})

describe('clearFileReadCache', () => {
  it('应清理所有缓存', async () => {
    mockInvoke.mockImplementation(() => 
      new Promise(resolve => setTimeout(() => resolve('content'), 100))
    )

    // 创建多个缓存
    const promise1 = readFileWithCache('/test/file1.ts')
    const promise2 = readFileWithCache('/test/file2.ts')

    // 清理缓存
    clearFileReadCache()

    // 再次读取应该创建新的 Promise
    const promise3 = readFileWithCache('/test/file1.ts')
    expect(promise3).not.toBe(promise1)

    // 等待所有 Promise 完成
    await Promise.allSettled([promise1, promise2, promise3])
  })
})

describe('handleAIEvent', () => {
  let mockStore: ReturnType<typeof createMockStoreSet>

  beforeEach(() => {
    vi.clearAllMocks()
    mockStore = createMockStoreSet()

    // Mock finishMessage, appendTextBlock 等方法
    mockStore.state.finishMessage = vi.fn(() => {
      mockStore.state.currentMessage = null
      mockStore.state.isStreaming = false
    })
    mockStore.state.appendTextBlock = vi.fn()
    mockStore.state.appendThinkingBlock = vi.fn()
    mockStore.state.appendToolCallBlock = vi.fn()
    mockStore.state.updateToolCallBlock = vi.fn()
    mockStore.state.updateToolCallBlockDiff = vi.fn()
    mockStore.state.updateToolCallBlockFullContent = vi.fn()
  })

  describe('session_start', () => {
    it('应设置 conversationId 和 isStreaming', () => {
      const event: AIEvent = {
        type: 'session_start',
        sessionId: 'session-123',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.set).toHaveBeenCalledWith({
        conversationId: 'session-123',
        isStreaming: true,
      })
      expect(mockClearTools).toHaveBeenCalled()
    })
  })

  describe('session_end', () => {
    it('应完成消息并重置状态', () => {
      mockStore.state.currentMessage = {
        id: 'msg-1',
        blocks: [],
        isStreaming: true,
      }

      const event: AIEvent = {
        type: 'session_end',
        reason: 'complete',
      }

      handleAIEvent(event, mockStore.set, mockStore.get, '/workspace')

      expect(mockStore.state.finishMessage).toHaveBeenCalled()
      expect(mockStore.set).toHaveBeenCalledWith({
        isStreaming: false,
        progressMessage: null,
      })
    })

    it('有 workspacePath 时应刷新 Git 状态', async () => {
      const event: AIEvent = {
        type: 'session_end',
        reason: 'complete',
      }

      handleAIEvent(event, mockStore.set, mockStore.get, '/workspace')

      // 等待微任务完成
      await Promise.resolve()
      expect(mockRefreshStatusDebounced).toHaveBeenCalledWith('/workspace')
    })
  })

  describe('token', () => {
    it('应追加文本块', () => {
      const event: AIEvent = {
        type: 'token',
        value: 'Hello',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.appendTextBlock).toHaveBeenCalledWith('Hello')
    })
  })

  describe('thinking', () => {
    it('应追加思考块', () => {
      const event: AIEvent = {
        type: 'thinking',
        content: 'Let me think...',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.appendThinkingBlock).toHaveBeenCalledWith('Let me think...')
    })
  })

  describe('assistant_message', () => {
    it('应追加文本块', () => {
      const event: AIEvent = {
        type: 'assistant_message',
        content: 'Response content',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.appendTextBlock).toHaveBeenCalledWith('Response content')
    })
  })

  describe('tool_call_start', () => {
    it('应追加工具调用块', () => {
      const event: AIEvent = {
        type: 'tool_call_start',
        callId: 'tool-1',
        tool: 'read_file',
        args: { path: '/test/file.ts' },
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.appendToolCallBlock).toHaveBeenCalledWith(
        'tool-1',
        'read_file',
        { path: '/test/file.ts' }
      )
    })

    it('无 callId 时应生成 UUID', () => {
      const event: AIEvent = {
        type: 'tool_call_start',
        tool: 'read_file',
        args: { path: '/test/file.ts' },
      }

      // Mock crypto.randomUUID
      vi.stubGlobal('crypto', {
        randomUUID: () => 'generated-uuid',
      })

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.appendToolCallBlock).toHaveBeenCalledWith(
        'generated-uuid',
        'read_file',
        { path: '/test/file.ts' }
      )

      vi.unstubAllGlobals()
    })

    it('Edit 工具应读取文件内容', async () => {
      mockInvoke.mockResolvedValueOnce('full file content')

      // 设置 toolBlockMap
      mockStore.state.toolBlockMap.set('tool-1', 0)
      mockStore.state.currentMessage = {
        id: 'msg-1',
        blocks: [{ type: 'tool_call', id: 'tool-1', name: 'Edit', status: 'pending', input: {} }],
        isStreaming: true,
      }

      const event: AIEvent = {
        type: 'tool_call_start',
        callId: 'tool-1',
        tool: 'Edit',
        args: { file_path: '/test/file.ts' },
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      // 等待异步读取完成
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(mockInvoke).toHaveBeenCalledWith('read_file_absolute', { path: '/test/file.ts' })
    })
  })

  describe('tool_call_end', () => {
    beforeEach(() => {
      vi.stubGlobal('crypto', {
        randomUUID: () => 'test-uuid',
      })
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('应更新工具调用块状态 (成功)', () => {
      const event: AIEvent = {
        type: 'tool_call_end',
        callId: 'tool-1',
        tool: 'read_file',
        success: true,
        result: 'file content',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updateToolCallBlock).toHaveBeenCalledWith(
        'tool-1',
        'completed',
        'file content'
      )
    })

    it('应更新工具调用块状态 (失败)', () => {
      const event: AIEvent = {
        type: 'tool_call_end',
        callId: 'tool-1',
        tool: 'read_file',
        success: false,
        result: 'error message',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updateToolCallBlock).toHaveBeenCalledWith(
        'tool-1',
        'failed',
        'error message'
      )
    })

    it('无 callId 时应输出警告', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const event: AIEvent = {
        type: 'tool_call_end',
        tool: 'read_file',
        success: true,
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(consoleSpy).toHaveBeenCalled()
      expect(mockStore.state.updateToolCallBlock).not.toHaveBeenCalled()

      consoleSpy.mockRestore()
    })

    it('有 workspacePath 时应刷新 Git 状态', async () => {
      const event: AIEvent = {
        type: 'tool_call_end',
        callId: 'tool-1',
        tool: 'read_file',
        success: true,
      }

      handleAIEvent(event, mockStore.set, mockStore.get, '/workspace')

      await Promise.resolve()
      expect(mockRefreshStatusDebounced).toHaveBeenCalledWith('/workspace')
    })
  })

  describe('progress', () => {
    it('应设置进度消息', () => {
      const event: AIEvent = {
        type: 'progress',
        message: 'Processing...',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.set).toHaveBeenCalledWith({ progressMessage: 'Processing...' })
    })

    it('无消息时应设置为 null', () => {
      const event: AIEvent = {
        type: 'progress',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.set).toHaveBeenCalledWith({ progressMessage: null })
    })
  })

  describe('error', () => {
    it('应完成消息并设置错误', () => {
      mockStore.state.currentMessage = {
        id: 'msg-1',
        blocks: [],
        isStreaming: true,
      }

      const event: AIEvent = {
        type: 'error',
        error: 'Something went wrong',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.finishMessage).toHaveBeenCalled()
      expect(mockStore.set).toHaveBeenCalledWith({
        error: 'Something went wrong',
        isStreaming: false,
      })
    })
  })

  describe('user_message', () => {
    it('不应处理用户消息', () => {
      const event: AIEvent = {
        type: 'user_message',
        content: 'Hello',
      }

      // 不应该抛出错误
      expect(() => handleAIEvent(event, mockStore.set, mockStore.get)).not.toThrow()
    })
  })

  // ========================================
  // QuestionBlock 事件测试
  // ========================================
  describe('tool_call_start (ask_user_question)', () => {
    beforeEach(() => {
      mockStore.state.appendQuestionBlock = vi.fn()
      mockStore.state.conversationId = 'session-123'
      // 设置 invoke mock 返回值，防止 .catch() 报错
      mockInvoke.mockResolvedValue(undefined)
    })

    it('应检测 ask_user_question 工具并添加问题块', () => {
      const event: AIEvent = {
        type: 'tool_call_start',
        callId: 'q-1',
        tool: 'ask_user_question',
        args: {
          header: '选择一个选项',
          options: [
            { value: 'a', label: 'Option A' },
            { value: 'b', label: 'Option B' },
          ],
          multiSelect: false,
          allowCustomInput: true,
        },
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.appendQuestionBlock).toHaveBeenCalledWith(
        'q-1',
        '选择一个选项',
        [
          { value: 'a', label: 'Option A', description: undefined, preview: undefined },
          { value: 'b', label: 'Option B', description: undefined, preview: undefined },
        ],
        false,
        true,
        undefined
      )
    })

    it('应支持 AskUserQuestion 大写格式', () => {
      const event: AIEvent = {
        type: 'tool_call_start',
        callId: 'q-1',
        tool: 'AskUserQuestion',
        args: {
          question: '确认操作？',
          options: ['yes', 'no'],
        },
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.appendQuestionBlock).toHaveBeenCalledWith(
        'q-1',
        '确认操作？',
        [
          { value: 'yes', label: 'yes', description: undefined, preview: undefined },
          { value: 'no', label: 'no', description: undefined, preview: undefined },
        ],
        false,
        false,
        undefined
      )
    })

    it('应支持 alternative 参数名称', () => {
      const event: AIEvent = {
        type: 'tool_call_start',
        callId: 'q-1',
        tool: 'ask_user_question',
        args: {
          message: '提示信息',
          multi_select: true,
          allowInput: true, // 注意：allow_input 不在支持的参数名列表中，使用 allowInput
        },
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.appendQuestionBlock).toHaveBeenCalledWith(
        'q-1',
        '提示信息',
        [],
        true,
        true,
        undefined
      )
    })

    it('应调用 register_pending_question 注册到后端', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      const event: AIEvent = {
        type: 'tool_call_start',
        callId: 'q-1',
        tool: 'ask_user_question',
        args: {
          header: 'Test',
          options: [{ value: 'a', label: 'A' }],
        },
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      // 等待异步调用
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(mockInvoke).toHaveBeenCalledWith('register_pending_question', {
        sessionId: 'session-123',
        callId: 'q-1',
        header: 'Test',
        multiSelect: false,
        options: [{ value: 'a', label: 'A' }],
        allowCustomInput: false,
      })
    })

    it('应支持 input 字段格式（IFlow CLI 格式）', () => {
      // 某些引擎（如 IFlow CLI）将问题参数放在 input 字段而非 args 字段
      const event = {
        type: 'tool_call_start' as const,
        callId: 'q-iflow-1',
        tool: 'AskUserQuestion',
        args: {}, // args 为空
        input: {
          message: 'Answer questions?',
          options: ['Yes', 'No'],
        },
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.appendQuestionBlock).toHaveBeenCalledWith(
        'q-iflow-1',
        'Answer questions?',
        [
          { value: 'Yes', label: 'Yes', description: undefined, preview: undefined },
          { value: 'No', label: 'No', description: undefined, preview: undefined },
        ],
        false,
        false,
        undefined
      )
    })

    it('应优先使用 input 字段（当 input 非空时）', () => {
      const event = {
        type: 'tool_call_start' as const,
        callId: 'q-mixed-1',
        tool: 'ask_user_question',
        args: {
          header: 'Args Header',
          options: ['A', 'B'],
        },
        input: {
          message: 'Input Message',
          options: ['X', 'Y'],
          multiSelect: true,
        },
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      // input 字段优先
      expect(mockStore.state.appendQuestionBlock).toHaveBeenCalledWith(
        'q-mixed-1',
        'Input Message',
        [
          { value: 'X', label: 'X', description: undefined, preview: undefined },
          { value: 'Y', label: 'Y', description: undefined, preview: undefined },
        ],
        true,
        false,
        undefined
      )
    })

    it('应支持 questions 数组格式（IFlow CLI 新格式）', () => {
      const event: AIEvent = {
        type: 'tool_call_start',
        callId: 'call_vThhbSZy7vCoA2WWt53a9aUu',
        tool: 'AskUserQuestion',
        args: {
          questions: [
            {
              header: '类别',
              question: '你想测试哪种类型的问题？',
              multiSelect: false,
              options: [
                {
                  label: '单选题',
                  description: '只有一个选项可选',
                  preview: '示例：你最喜欢的颜色是什么？',
                },
                {
                  label: '多选题',
                  description: '可以选择多个选项',
                  preview: '示例：你喜欢哪些水果？',
                },
              ],
            },
          ],
        },
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      // 验证调用参数
      expect(mockStore.state.appendQuestionBlock).toHaveBeenCalledWith(
        'call_vThhbSZy7vCoA2WWt53a9aUu',
        '你想测试哪种类型的问题？', // 使用 question 字段作为问题文本
        [
          {
            value: '单选题',
            label: '单选题',
            description: '只有一个选项可选',
            preview: '示例：你最喜欢的颜色是什么？',
          },
          {
            value: '多选题',
            label: '多选题',
            description: '可以选择多个选项',
            preview: '示例：你喜欢哪些水果？',
          },
        ],
        false,
        false,
        '类别' // categoryLabel
      )
    })

    it('应支持 questions 数组格式中的 input 字段', () => {
      const event = {
        type: 'tool_call_start' as const,
        callId: 'q-new-format',
        tool: 'AskUserQuestion',
        args: {},
        input: {
          questions: [
            {
              header: '操作类型',
              question: '请选择要执行的操作',
              options: [
                { label: '创建', description: '创建新文件' },
                { label: '删除', description: '删除文件' },
              ],
            },
          ],
        },
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.appendQuestionBlock).toHaveBeenCalledWith(
        'q-new-format',
        '请选择要执行的操作',
        [
          { value: '创建', label: '创建', description: '创建新文件' },
          { value: '删除', label: '删除', description: '删除文件' },
        ],
        false,
        false,
        '操作类型'
      )
    })
  })

  describe('question_answered', () => {
    beforeEach(() => {
      mockStore.state.updateQuestionBlock = vi.fn()
    })

    it('应更新问题块的答案', () => {
      const event: AIEvent = {
        type: 'question_answered',
        callId: 'q-1',
        answer: {
          selected: ['a', 'b'],
          customInput: undefined,
        },
      } as any

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updateQuestionBlock).toHaveBeenCalledWith('q-1', {
        selected: ['a', 'b'],
        customInput: undefined,
      })
    })

    it('应支持自定义输入答案', () => {
      const event: AIEvent = {
        type: 'question_answered',
        callId: 'q-1',
        answer: {
          selected: [],
          customInput: 'My custom answer',
        },
      } as any

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updateQuestionBlock).toHaveBeenCalledWith('q-1', {
        selected: [],
        customInput: 'My custom answer',
      })
    })
  })

  describe('tool_call_end (ask_user_question)', () => {
    beforeEach(() => {
      mockStore.state.updateQuestionBlock = vi.fn()
      mockStore.state.questionBlockMap = new Map([['q-1', 0]])
      mockStore.state.currentMessage = {
        id: 'msg-1',
        blocks: [{ type: 'question', id: 'q-1', status: 'pending', options: [] }],
        isStreaming: true,
      }
    })

    it('应从 result 提取答案', () => {
      const event: AIEvent = {
        type: 'tool_call_end',
        callId: 'q-1',
        tool: 'ask_user_question',
        success: true,
        result: {
          selected: ['a'],
          customInput: undefined,
        },
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updateQuestionBlock).toHaveBeenCalledWith('q-1', {
        selected: ['a'],
        customInput: undefined,
      })
    })

    it('问题块已有答案时不重复更新', () => {
      mockStore.state.currentMessage = {
        id: 'msg-1',
        blocks: [{
          type: 'question',
          id: 'q-1',
          status: 'answered',
          options: [],
          answer: { selected: ['existing'] },
        }],
        isStreaming: true,
      }

      const event: AIEvent = {
        type: 'tool_call_end',
        callId: 'q-1',
        tool: 'ask_user_question',
        success: true,
        result: { selected: ['new'] },
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updateQuestionBlock).not.toHaveBeenCalled()
    })
  })

  // ========================================
  // PlanMode 事件测试
  // ========================================
  describe('plan_start', () => {
    beforeEach(() => {
      mockStore.state.appendPlanModeBlock = vi.fn()
    })

    it('应创建新的 PlanModeBlock', () => {
      const event: AIEvent = {
        type: 'plan_start',
        sessionId: 'session-123',
        planId: 'plan-1',
      } as any

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.appendPlanModeBlock).toHaveBeenCalledWith(
        'plan-1',
        'session-123'
      )
    })
  })

  describe('plan_content', () => {
    beforeEach(() => {
      mockStore.state.updatePlanModeBlock = vi.fn()
    })

    it('应更新计划内容', () => {
      const event: AIEvent = {
        type: 'plan_content',
        sessionId: 'session-123',
        planId: 'plan-1',
        title: '计划标题',
        description: '计划描述',
        stages: [
          {
            stageId: 'stage-1',
            name: '阶段1',
            status: 'pending',
            tasks: [],
          },
        ],
        status: 'drafting',
      } as any

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updatePlanModeBlock).toHaveBeenCalledWith('plan-1', {
        title: '计划标题',
        description: '计划描述',
        stages: [
          {
            stageId: 'stage-1',
            name: '阶段1',
            status: 'pending',
            tasks: [],
          },
        ],
        status: 'drafting',
      })
    })
  })

  describe('plan_stage_update', () => {
    beforeEach(() => {
      mockStore.state.updatePlanStageStatus = vi.fn()
    })

    it('应更新阶段状态', () => {
      const event: AIEvent = {
        type: 'plan_stage_update',
        sessionId: 'session-123',
        planId: 'plan-1',
        stageId: 'stage-1',
        status: 'in_progress',
        tasks: [
          { taskId: 'task-1', description: '任务1', status: 'pending' },
        ],
      } as any

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updatePlanStageStatus).toHaveBeenCalledWith(
        'plan-1',
        'stage-1',
        'in_progress',
        [
          { taskId: 'task-1', description: '任务1', status: 'pending' },
        ]
      )
    })
  })

  describe('plan_approval_request', () => {
    beforeEach(() => {
      mockStore.state.updatePlanModeBlock = vi.fn()
      mockStore.state.planBlockMap = new Map([['plan-1', 0]])
      mockStore.state.currentMessage = {
        id: 'msg-1',
        blocks: [{
          type: 'plan_mode',
          id: 'plan-1',
          status: 'drafting',
          title: '测试计划',
          description: '描述',
        }],
        isStreaming: true,
      }
    })

    it('应更新计划状态为 pending_approval', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      const event: AIEvent = {
        type: 'plan_approval_request',
        sessionId: 'session-123',
        planId: 'plan-1',
        message: '请审批',
      } as any

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updatePlanModeBlock).toHaveBeenCalledWith('plan-1', {
        status: 'pending_approval',
        isActive: true,
      })

      // 等待异步调用
      await new Promise(resolve => setTimeout(resolve, 10))
    })
  })

  describe('plan_approval_result', () => {
    beforeEach(() => {
      mockStore.state.updatePlanModeBlock = vi.fn()
    })

    it('审批通过应更新状态为 approved', () => {
      const event: AIEvent = {
        type: 'plan_approval_result',
        sessionId: 'session-123',
        planId: 'plan-1',
        approved: true,
        feedback: 'Good plan',
      } as any

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updatePlanModeBlock).toHaveBeenCalledWith('plan-1', {
        status: 'approved',
        feedback: 'Good plan',
        isActive: false,
      })
    })

    it('审批拒绝应更新状态为 rejected', () => {
      const event: AIEvent = {
        type: 'plan_approval_result',
        sessionId: 'session-123',
        planId: 'plan-1',
        approved: false,
        feedback: '需要修改',
      } as any

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updatePlanModeBlock).toHaveBeenCalledWith('plan-1', {
        status: 'rejected',
        feedback: '需要修改',
        isActive: true,
      })
    })
  })

  describe('plan_end', () => {
    beforeEach(() => {
      mockStore.state.updatePlanModeBlock = vi.fn()
      mockStore.state.activePlanId = 'plan-1'
    })

    it('应更新计划状态并清除 activePlanId', () => {
      const event: AIEvent = {
        type: 'plan_end',
        sessionId: 'session-123',
        planId: 'plan-1',
        status: 'completed',
        reason: 'Plan executed successfully',
      } as any

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updatePlanModeBlock).toHaveBeenCalledWith('plan-1', {
        status: 'completed',
        isActive: false,
      })
      expect(mockStore.set).toHaveBeenCalledWith({ activePlanId: null })
    })
  })

  // ========================================
  // AgentRun (Task) 事件测试
  // ========================================
  describe('task_metadata', () => {
    beforeEach(() => {
      mockStore.state.appendAgentRunBlock = vi.fn()
    })

    it('任务开始时应创建 AgentRunBlock', () => {
      const event: AIEvent = {
        type: 'task_metadata',
        taskId: 'task-1',
        status: 'running',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.appendAgentRunBlock).toHaveBeenCalledWith(
        'task-1',
        'Agent',
        undefined
      )
    })

    it('任务 pending 状态时也应创建 AgentRunBlock', () => {
      const event: AIEvent = {
        type: 'task_metadata',
        taskId: 'task-1',
        status: 'pending',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.appendAgentRunBlock).toHaveBeenCalledWith(
        'task-1',
        'Agent',
        undefined
      )
    })

    it('任务完成时不应创建 AgentRunBlock', () => {
      const event: AIEvent = {
        type: 'task_metadata',
        taskId: 'task-1',
        status: 'success',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.appendAgentRunBlock).not.toHaveBeenCalled()
    })
  })

  describe('task_progress', () => {
    beforeEach(() => {
      mockStore.state.updateAgentRunBlock = vi.fn()
    })

    it('应更新 AgentRunBlock 进度', () => {
      const event: AIEvent = {
        type: 'task_progress',
        taskId: 'task-1',
        message: 'Processing...',
        percent: 50,
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updateAgentRunBlock).toHaveBeenCalledWith('task-1', {
        progressMessage: 'Processing...',
        progressPercent: 50,
      })
    })

    it('应支持只有消息没有百分比', () => {
      const event: AIEvent = {
        type: 'task_progress',
        taskId: 'task-1',
        message: 'Starting...',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updateAgentRunBlock).toHaveBeenCalledWith('task-1', {
        progressMessage: 'Starting...',
        progressPercent: undefined,
      })
    })
  })

  describe('task_completed', () => {
    beforeEach(() => {
      mockStore.state.updateAgentRunBlock = vi.fn()
      mockStore.state.activeTaskId = 'task-1'
    })

    it('应更新 AgentRunBlock 状态为 success', () => {
      const event: AIEvent = {
        type: 'task_completed',
        taskId: 'task-1',
        status: 'success',
        duration: 1000,
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updateAgentRunBlock).toHaveBeenCalledWith('task-1', {
        status: 'success',
        duration: 1000,
        error: undefined,
        completedAt: expect.any(String),
      })
    })

    it('应更新 AgentRunBlock 状态为 error', () => {
      const event: AIEvent = {
        type: 'task_completed',
        taskId: 'task-1',
        status: 'error',
        error: 'Task failed',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updateAgentRunBlock).toHaveBeenCalledWith('task-1', {
        status: 'error',
        duration: undefined,
        error: 'Task failed',
        completedAt: expect.any(String),
      })
    })

    it('应清除 activeTaskId', () => {
      const event: AIEvent = {
        type: 'task_completed',
        taskId: 'task-1',
        status: 'success',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.set).toHaveBeenCalledWith({ activeTaskId: null })
    })

    it('不同 taskId 不应清除 activeTaskId', () => {
      mockStore.state.activeTaskId = 'task-2'

      const event: AIEvent = {
        type: 'task_completed',
        taskId: 'task-1',
        status: 'success',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.set).not.toHaveBeenCalledWith({ activeTaskId: null })
    })
  })

  describe('task_canceled', () => {
    beforeEach(() => {
      mockStore.state.updateAgentRunBlock = vi.fn()
      mockStore.state.activeTaskId = 'task-1'
    })

    it('应更新 AgentRunBlock 状态为 canceled', () => {
      const event: AIEvent = {
        type: 'task_canceled',
        taskId: 'task-1',
        reason: 'User cancelled',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.state.updateAgentRunBlock).toHaveBeenCalledWith('task-1', {
        status: 'canceled',
        error: 'User cancelled',
        completedAt: expect.any(String),
      })
    })

    it('应清除 activeTaskId', () => {
      const event: AIEvent = {
        type: 'task_canceled',
        taskId: 'task-1',
      }

      handleAIEvent(event, mockStore.set, mockStore.get)

      expect(mockStore.set).toHaveBeenCalledWith({ activeTaskId: null })
    })
  })

  // ========================================
  // 交互结果处理测试
  // ========================================
  describe('交互结果处理流程', () => {
    describe('buildAnswerPrompt 格式', () => {
      it('应正确构建单选答案 prompt', () => {
        // 模拟 buildAnswerPrompt 函数逻辑
        const buildAnswerPrompt = (answerData: { selected: string[]; customInput?: string }, header: string, options: any[]) => {
          const parts: string[] = [`[交互回答] 问题: "${header}"`]

          if (answerData.selected.length > 0) {
            const selectedLabels = answerData.selected.map(value => {
              const option = options.find(o => o.value === value)
              return option?.label || value
            })
            parts.push(`选择的选项: ${selectedLabels.join(', ')}`)
          }

          if (answerData.customInput) {
            parts.push(`自定义输入: ${answerData.customInput}`)
          }

          return parts.join('\n')
        }

        const result = buildAnswerPrompt(
          { selected: ['a'] },
          '选择一个选项',
          [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }]
        )

        expect(result).toBe('[交互回答] 问题: "选择一个选项"\n选择的选项: Option A')
      })

      it('应正确构建多选答案 prompt', () => {
        const buildAnswerPrompt = (answerData: { selected: string[]; customInput?: string }, header: string, options: any[]) => {
          const parts: string[] = [`[交互回答] 问题: "${header}"`]

          if (answerData.selected.length > 0) {
            const selectedLabels = answerData.selected.map(value => {
              const option = options.find(o => o.value === value)
              return option?.label || value
            })
            parts.push(`选择的选项: ${selectedLabels.join(', ')}`)
          }

          if (answerData.customInput) {
            parts.push(`自定义输入: ${answerData.customInput}`)
          }

          return parts.join('\n')
        }

        const result = buildAnswerPrompt(
          { selected: ['a', 'b'] },
          '选择多个选项',
          [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }]
        )

        expect(result).toBe('[交互回答] 问题: "选择多个选项"\n选择的选项: Option A, Option B')
      })

      it('应正确构建自定义输入答案 prompt', () => {
        const buildAnswerPrompt = (answerData: { selected: string[]; customInput?: string }, header: string, options: any[]) => {
          const parts: string[] = [`[交互回答] 问题: "${header}"`]

          if (answerData.selected.length > 0) {
            const selectedLabels = answerData.selected.map(value => {
              const option = options.find(o => o.value === value)
              return option?.label || value
            })
            parts.push(`选择的选项: ${selectedLabels.join(', ')}`)
          }

          if (answerData.customInput) {
            parts.push(`自定义输入: ${answerData.customInput}`)
          }

          return parts.join('\n')
        }

        const result = buildAnswerPrompt(
          { selected: [], customInput: '自定义答案内容' },
          '请输入您的答案',
          []
        )

        expect(result).toBe('[交互回答] 问题: "请输入您的答案"\n自定义输入: 自定义答案内容')
      })

      it('应正确构建选项加自定义输入的混合答案 prompt', () => {
        const buildAnswerPrompt = (answerData: { selected: string[]; customInput?: string }, header: string, options: any[]) => {
          const parts: string[] = [`[交互回答] 问题: "${header}"`]

          if (answerData.selected.length > 0) {
            const selectedLabels = answerData.selected.map(value => {
              const option = options.find(o => o.value === value)
              return option?.label || value
            })
            parts.push(`选择的选项: ${selectedLabels.join(', ')}`)
          }

          if (answerData.customInput) {
            parts.push(`自定义输入: ${answerData.customInput}`)
          }

          return parts.join('\n')
        }

        const result = buildAnswerPrompt(
          { selected: ['a'], customInput: '补充说明' },
          '选择并补充',
          [{ value: 'a', label: 'Option A' }]
        )

        expect(result).toBe('[交互回答] 问题: "选择并补充"\n选择的选项: Option A\n自定义输入: 补充说明')
      })
    })

    describe('buildApprovalPrompt 格式', () => {
      it('应正确构建批准计划 prompt', () => {
        const buildApprovalPrompt = (approved: boolean, feedback: string | undefined, title: string) => {
          const action = approved ? '批准' : '拒绝'
          const parts: string[] = [`[计划审批] 用户${action}了计划: "${title}"`]

          if (!approved && feedback) {
            parts.push(`反馈意见: ${feedback}`)
          }

          return parts.join('\n')
        }

        const result = buildApprovalPrompt(true, undefined, '重构计划')

        expect(result).toBe('[计划审批] 用户批准了计划: "重构计划"')
      })

      it('应正确构建拒绝计划 prompt（无反馈）', () => {
        const buildApprovalPrompt = (approved: boolean, feedback: string | undefined, title: string) => {
          const action = approved ? '批准' : '拒绝'
          const parts: string[] = [`[计划审批] 用户${action}了计划: "${title}"`]

          if (!approved && feedback) {
            parts.push(`反馈意见: ${feedback}`)
          }

          return parts.join('\n')
        }

        const result = buildApprovalPrompt(false, undefined, '重构计划')

        expect(result).toBe('[计划审批] 用户拒绝了计划: "重构计划"')
      })

      it('应正确构建拒绝计划 prompt（有反馈）', () => {
        const buildApprovalPrompt = (approved: boolean, feedback: string | undefined, title: string) => {
          const action = approved ? '批准' : '拒绝'
          const parts: string[] = [`[计划审批] 用户${action}了计划: "${title}"`]

          if (!approved && feedback) {
            parts.push(`反馈意见: ${feedback}`)
          }

          return parts.join('\n')
        }

        const result = buildApprovalPrompt(false, '需要更多测试覆盖', '重构计划')

        expect(result).toBe('[计划审批] 用户拒绝了计划: "重构计划"\n反馈意见: 需要更多测试覆盖')
      })
    })

    describe('answer_question 命令调用', () => {
      beforeEach(() => {
        mockStore.state.updateQuestionBlock = vi.fn()
      })

      it('question_answered 事件应触发 updateQuestionBlock', () => {
        const event: AIEvent = {
          type: 'question_answered',
          callId: 'q-1',
          answer: {
            selected: ['a'],
            customInput: undefined,
          },
        }

        handleAIEvent(event, mockStore.set, mockStore.get)

        // updateQuestionBlock 直接接收 answer 对象，不是 { status, answer } 结构
        expect(mockStore.state.updateQuestionBlock).toHaveBeenCalledWith('q-1', {
          selected: ['a'],
          customInput: undefined,
        })
      })
    })
  })
})
