/**
 * messageSlice 单元测试
 *
 * 测试消息状态管理的核心功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock utils module
vi.mock('./utils', () => ({
  clearFileReadCache: vi.fn(),
}))

// Mock toolSummary
vi.mock('../../utils/toolSummary', () => ({
  generateToolSummary: vi.fn(() => 'Tool summary'),
  calculateDuration: vi.fn(() => '1s'),
}))

// Import after mocking
import { createMessageSlice } from './messageSlice'
import type { EventChatState } from './types'

// 创建测试用的 store
function createTestStore() {
  return create<EventChatState>((...args) => {
    const slice = createMessageSlice(...args)
    
    return {
      // 最小状态集合用于测试
      messages: [],
      archivedMessages: [],
      currentMessage: null,
      toolBlockMap: new Map(),
      streamingUpdateCounter: 0,
      conversationId: null,
      currentConversationSeed: null,
      isStreaming: false,
      error: null,
      progressMessage: null,
      _eventListenersInitialized: false,
      _eventListenersCleanup: null,
      _dependencies: null,
      isInitialized: true,
      isLoadingHistory: false,
      isArchiveExpanded: false,
      maxMessages: 500,

      // 需要的方法
      saveToStorage: vi.fn(),

      // 依赖注入方法
      getGitActions: () => null,
      getConfigActions: () => null,
      getWorkspaceActions: () => null,
      setDependencies: vi.fn(),

      // 应用 messageSlice
      ...slice,
    } as any
  })
}

describe('messageSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Mock sessionStorage
    vi.stubGlobal('sessionStorage', {
      setItem: vi.fn(),
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      clear: vi.fn(),
    })
    // Mock crypto.randomUUID
    vi.stubGlobal('crypto', {
      randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('addMessage', () => {
    it('应正确添加消息到消息列表', () => {
      const store = createTestStore()
      const message = {
        id: 'msg-1',
        type: 'user' as const,
        content: 'Hello',
        timestamp: new Date().toISOString(),
      }

      store.getState().addMessage(message)

      expect(store.getState().messages).toHaveLength(1)
      expect(store.getState().messages[0]).toEqual(message)
    })

    it('应按顺序添加多条消息', () => {
      const store = createTestStore()

      store.getState().addMessage({
        id: 'msg-1',
        type: 'user' as const,
        content: 'Hello',
        timestamp: new Date().toISOString(),
      })

      store.getState().addMessage({
        id: 'msg-2',
        type: 'assistant' as const,
        blocks: [{ type: 'text' as const, content: 'Hi there' }],
        timestamp: new Date().toISOString(),
        isStreaming: false,
      })

      expect(store.getState().messages).toHaveLength(2)
      expect(store.getState().messages[0].id).toBe('msg-1')
      expect(store.getState().messages[1].id).toBe('msg-2')
    })
  })

  describe('appendTextBlock', () => {
    it('无 currentMessage 时应创建新消息', () => {
      const store = createTestStore()

      store.getState().appendTextBlock('Hello')

      const { currentMessage } = store.getState()
      expect(currentMessage).not.toBeNull()
      expect(currentMessage?.blocks).toHaveLength(1)
      expect(currentMessage?.blocks[0]).toEqual({
        type: 'text',
        content: 'Hello',
      })
      expect(store.getState().isStreaming).toBe(true)
    })

    it('应追加到最后一个文本块', () => {
      const store = createTestStore()

      // 先添加一个文本块
      store.getState().appendTextBlock('Hello')
      // 再追加
      store.getState().appendTextBlock(' World')

      const { currentMessage } = store.getState()
      expect(currentMessage?.blocks).toHaveLength(1)
      expect((currentMessage?.blocks[0] as any).content).toBe('Hello World')
    })

    it('最后块非文本时应创建新块', () => {
      const store = createTestStore()

      // 模拟设置一个带有思考块的 currentMessage
      store.setState({
        currentMessage: {
          id: 'test-id',
          blocks: [{ type: 'thinking', content: 'Thinking...', collapsed: false }],
          isStreaming: true,
        },
      })

      store.getState().appendTextBlock('Response')

      const { currentMessage } = store.getState()
      expect(currentMessage?.blocks).toHaveLength(2)
      expect(currentMessage?.blocks[1]).toEqual({
        type: 'text',
        content: 'Response',
      })
    })
  })

  describe('appendThinkingBlock', () => {
    it('无 currentMessage 时应创建新消息', () => {
      const store = createTestStore()

      store.getState().appendThinkingBlock('Thinking...')

      const { currentMessage } = store.getState()
      expect(currentMessage).not.toBeNull()
      expect(currentMessage?.blocks).toHaveLength(1)
      expect(currentMessage?.blocks[0]).toEqual({
        type: 'thinking',
        content: 'Thinking...',
        collapsed: false,
      })
    })

    it('应追加到现有消息', () => {
      const store = createTestStore()

      store.getState().appendTextBlock('Hello')
      store.getState().appendThinkingBlock('Let me think...')

      const { currentMessage } = store.getState()
      expect(currentMessage?.blocks).toHaveLength(2)
      expect(currentMessage?.blocks[1]).toEqual({
        type: 'thinking',
        content: 'Let me think...',
        collapsed: false,
      })
    })
  })

  describe('finishMessage', () => {
    it('应将 currentMessage 标记为完成', () => {
      const store = createTestStore()

      // 设置 currentMessage
      store.setState({
        currentMessage: {
          id: 'msg-1',
          blocks: [{ type: 'text', content: 'Hello' }],
          isStreaming: true,
        },
        isStreaming: true,
      })

      store.getState().finishMessage()

      expect(store.getState().currentMessage).toBeNull()
      expect(store.getState().isStreaming).toBe(false)
    })

    it('无 currentMessage 时应重置 isStreaming 状态', () => {
      const store = createTestStore()
      store.setState({ isStreaming: true })

      store.getState().finishMessage()

      expect(store.getState().isStreaming).toBe(false)
    })
  })

  describe('appendToolCallBlock', () => {
    it('无 currentMessage 时应创建新消息', () => {
      const store = createTestStore()

      store.getState().appendToolCallBlock('tool-1', 'read_file', { path: '/test/file.ts' })

      const { currentMessage, toolBlockMap } = store.getState()
      expect(currentMessage).not.toBeNull()
      expect(currentMessage?.blocks).toHaveLength(1)
      expect(currentMessage?.blocks[0]).toMatchObject({
        type: 'tool_call',
        id: 'tool-1',
        name: 'read_file',
        status: 'pending',
      })
      expect(toolBlockMap.get('tool-1')).toBe(0)
    })

    it('应正确更新 toolBlockMap', () => {
      const store = createTestStore()

      store.getState().appendToolCallBlock('tool-1', 'read_file', { path: '/test' })
      store.getState().appendToolCallBlock('tool-2', 'write_file', { path: '/test2' })

      const { toolBlockMap } = store.getState()
      expect(toolBlockMap.get('tool-1')).toBe(0)
      expect(toolBlockMap.get('tool-2')).toBe(1)
    })
  })

  describe('updateToolCallBlock', () => {
    it('应更新工具调用块状态', () => {
      const store = createTestStore()

      // 先添加一个工具调用块
      store.getState().appendToolCallBlock('tool-1', 'read_file', { path: '/test' })

      // 更新状态
      store.getState().updateToolCallBlock('tool-1', 'success', 'file content')

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.status).toBe('success')
      expect(block.output).toBe('file content')
    })

    it('不存在的工具 ID 应不影响状态', () => {
      const store = createTestStore()

      store.getState().appendToolCallBlock('tool-1', 'read_file', { path: '/test' })

      // 尝试更新不存在的工具
      store.getState().updateToolCallBlock('nonexistent', 'success')

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.status).toBe('pending') // 状态不变
    })
  })

  // ========================================
  // QuestionBlock 测试
  // ========================================
  describe('appendQuestionBlock', () => {
    it('无 currentMessage 时应创建新消息', () => {
      const store = createTestStore()

      const options = [
        { value: 'option1', label: 'Option 1' },
        { value: 'option2', label: 'Option 2' },
      ]

      store.getState().appendQuestionBlock('question-1', '选择一个选项', options, false, true)

      const { currentMessage, questionBlockMap } = store.getState()
      expect(currentMessage).not.toBeNull()
      expect(currentMessage?.blocks).toHaveLength(1)
      expect(currentMessage?.blocks[0]).toMatchObject({
        type: 'question',
        id: 'question-1',
        header: '选择一个选项',
        options,
        multiSelect: false,
        allowCustomInput: true,
        status: 'pending',
      })
      expect(questionBlockMap.get('question-1')).toBe(0)
    })

    it('应追加到现有消息', () => {
      const store = createTestStore()

      // 先添加文本块
      store.getState().appendTextBlock('Hello')

      const options = [{ value: 'yes', label: 'Yes' }]
      store.getState().appendQuestionBlock('question-1', '确认操作?', options, false)

      const { currentMessage, questionBlockMap } = store.getState()
      expect(currentMessage?.blocks).toHaveLength(2)
      expect(currentMessage?.blocks[1]).toMatchObject({
        type: 'question',
        id: 'question-1',
      })
      expect(questionBlockMap.get('question-1')).toBe(1)
    })

    it('应正确更新 questionBlockMap', () => {
      const store = createTestStore()

      store.getState().appendQuestionBlock('q-1', 'Q1', [])
      store.getState().appendQuestionBlock('q-2', 'Q2', [])

      const { questionBlockMap } = store.getState()
      expect(questionBlockMap.get('q-1')).toBe(0)
      expect(questionBlockMap.get('q-2')).toBe(1)
    })
  })

  describe('updateQuestionBlock', () => {
    it('应更新问题块的答案', () => {
      const store = createTestStore()

      const options = [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ]
      store.getState().appendQuestionBlock('q-1', 'Select', options, false)

      // 更新答案
      const answer = { selected: ['a'], customInput: undefined }
      store.getState().updateQuestionBlock('q-1', answer)

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.status).toBe('answered')
      expect(block.answer).toEqual(answer)
    })

    it('应支持多选答案', () => {
      const store = createTestStore()

      const options = [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ]
      store.getState().appendQuestionBlock('q-1', 'Select', options, true)

      // 多选答案
      const answer = { selected: ['a', 'b'] }
      store.getState().updateQuestionBlock('q-1', answer)

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.answer.selected).toEqual(['a', 'b'])
    })

    it('应支持自定义输入', () => {
      const store = createTestStore()

      store.getState().appendQuestionBlock('q-1', 'Input', [], false, true)

      // 自定义输入答案
      const answer = { selected: [], customInput: 'My custom answer' }
      store.getState().updateQuestionBlock('q-1', answer)

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.answer.customInput).toBe('My custom answer')
    })

    it('不存在的问题 ID 应不影响状态', () => {
      const store = createTestStore()

      store.getState().appendQuestionBlock('q-1', 'Q1', [])
      store.getState().updateQuestionBlock('nonexistent', { selected: ['a'] })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.status).toBe('pending')
    })
  })

  // ========================================
  // PlanMode 测试
  // ========================================
  describe('appendPlanModeBlock', () => {
    it('无 currentMessage 时应创建新消息', () => {
      const store = createTestStore()

      const stages = [
        {
          stageId: 'stage-1',
          name: '阶段1',
          status: 'pending' as const,
          tasks: [],
        },
      ]

      store.getState().appendPlanModeBlock('plan-1', 'session-123', '计划标题', '计划描述', stages)

      const { currentMessage, planBlockMap, activePlanId } = store.getState()
      expect(currentMessage).not.toBeNull()
      expect(currentMessage?.blocks).toHaveLength(1)
      expect(currentMessage?.blocks[0]).toMatchObject({
        type: 'plan_mode',
        id: 'plan-1',
        sessionId: 'session-123',
        title: '计划标题',
        description: '计划描述',
        stages,
        status: 'drafting',
        isActive: true,
      })
      expect(planBlockMap.get('plan-1')).toBe(0)
      expect(activePlanId).toBe('plan-1')
    })

    it('应追加到现有消息', () => {
      const store = createTestStore()

      store.getState().appendTextBlock('Planning...')
      store.getState().appendPlanModeBlock('plan-1', 'session-123')

      const { currentMessage, planBlockMap, activePlanId } = store.getState()
      expect(currentMessage?.blocks).toHaveLength(2)
      expect(currentMessage?.blocks[1]).toMatchObject({
        type: 'plan_mode',
        id: 'plan-1',
      })
      expect(planBlockMap.get('plan-1')).toBe(1)
      expect(activePlanId).toBe('plan-1')
    })
  })

  describe('updatePlanModeBlock', () => {
    it('应更新计划块状态', () => {
      const store = createTestStore()

      store.getState().appendPlanModeBlock('plan-1', 'session-123')
      store.getState().updatePlanModeBlock('plan-1', { status: 'pending_approval' })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.status).toBe('pending_approval')
    })

    it('应更新计划块内容', () => {
      const store = createTestStore()

      store.getState().appendPlanModeBlock('plan-1', 'session-123')
      store.getState().updatePlanModeBlock('plan-1', {
        title: '更新后的标题',
        description: '更新后的描述',
      })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.title).toBe('更新后的标题')
      expect(block.description).toBe('更新后的描述')
    })

    it('应更新 isActive 状态', () => {
      const store = createTestStore()

      store.getState().appendPlanModeBlock('plan-1', 'session-123')
      store.getState().updatePlanModeBlock('plan-1', { isActive: false })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.isActive).toBe(false)
    })
  })

  describe('updatePlanStageStatus', () => {
    it('应更新阶段状态', () => {
      const store = createTestStore()

      const stages = [
        {
          stageId: 'stage-1',
          name: '阶段1',
          status: 'pending' as const,
          tasks: [],
        },
      ]
      store.getState().appendPlanModeBlock('plan-1', 'session-123', undefined, undefined, stages)
      store.getState().updatePlanStageStatus('plan-1', 'stage-1', 'in_progress')

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.stages[0].status).toBe('in_progress')
    })

    it('应更新阶段任务列表', () => {
      const store = createTestStore()

      const stages = [
        {
          stageId: 'stage-1',
          name: '阶段1',
          status: 'pending' as const,
          tasks: [],
        },
      ]
      store.getState().appendPlanModeBlock('plan-1', 'session-123', undefined, undefined, stages)

      const newTasks = [
        { taskId: 'task-1', content: '任务1', status: 'pending' as const },
      ]
      store.getState().updatePlanStageStatus('plan-1', 'stage-1', 'in_progress', newTasks)

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.stages[0].tasks).toHaveLength(1)
      expect(block.stages[0].tasks[0].taskId).toBe('task-1')
    })

    it('不存在的问题 ID 应不影响状态', () => {
      const store = createTestStore()

      const stages = [
        {
          stageId: 'stage-1',
          name: '阶段1',
          status: 'pending' as const,
          tasks: [],
        },
      ]
      store.getState().appendPlanModeBlock('plan-1', 'session-123', undefined, undefined, stages)
      store.getState().updatePlanStageStatus('plan-1', 'nonexistent', 'completed')

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.stages[0].status).toBe('pending') // 状态不变
    })
  })

  describe('setActivePlan', () => {
    it('应设置活跃计划 ID', () => {
      const store = createTestStore()

      store.getState().setActivePlan('plan-123')
      expect(store.getState().activePlanId).toBe('plan-123')
    })

    it('应支持设置为 null', () => {
      const store = createTestStore()

      store.getState().setActivePlan('plan-123')
      store.getState().setActivePlan(null)
      expect(store.getState().activePlanId).toBeNull()
    })
  })

  // ========================================
  // AgentRun 测试
  // ========================================
  describe('appendAgentRunBlock', () => {
    it('无 currentMessage 时应创建新消息', () => {
      const store = createTestStore()

      store.getState().appendAgentRunBlock('task-1', 'claude', ['read', 'write', 'edit'])

      const { currentMessage, agentRunBlockMap, activeTaskId } = store.getState()
      expect(currentMessage).not.toBeNull()
      expect(currentMessage?.blocks).toHaveLength(1)
      expect(currentMessage?.blocks[0]).toMatchObject({
        type: 'agent_run',
        id: 'task-1',
        agentType: 'claude',
        capabilities: ['read', 'write', 'edit'],
        status: 'running',
        toolCalls: [],
      })
      expect(agentRunBlockMap.get('task-1')).toBe(0)
      expect(activeTaskId).toBe('task-1')
    })

    it('应追加到现有消息', () => {
      const store = createTestStore()

      store.getState().appendTextBlock('Starting agent...')
      store.getState().appendAgentRunBlock('task-1', 'claude')

      const { currentMessage, agentRunBlockMap, activeTaskId } = store.getState()
      expect(currentMessage?.blocks).toHaveLength(2)
      expect(currentMessage?.blocks[1]).toMatchObject({
        type: 'agent_run',
        id: 'task-1',
      })
      expect(agentRunBlockMap.get('task-1')).toBe(1)
      expect(activeTaskId).toBe('task-1')
    })

    it('应支持无 capabilities 参数', () => {
      const store = createTestStore()

      store.getState().appendAgentRunBlock('task-1', 'claude')

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.capabilities).toBeUndefined()
    })
  })

  describe('updateAgentRunBlock', () => {
    it('应更新 Agent 运行块状态', () => {
      const store = createTestStore()

      store.getState().appendAgentRunBlock('task-1', 'claude')
      store.getState().updateAgentRunBlock('task-1', { status: 'success' })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.status).toBe('success')
    })

    it('应更新进度信息', () => {
      const store = createTestStore()

      store.getState().appendAgentRunBlock('task-1', 'claude')
      store.getState().updateAgentRunBlock('task-1', {
        progressMessage: 'Processing...',
        progressPercent: 50,
      })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.progressMessage).toBe('Processing...')
      expect(block.progressPercent).toBe(50)
    })

    it('应更新错误信息', () => {
      const store = createTestStore()

      store.getState().appendAgentRunBlock('task-1', 'claude')
      store.getState().updateAgentRunBlock('task-1', {
        status: 'error',
        error: 'Task failed',
      })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.status).toBe('error')
      expect(block.error).toBe('Task failed')
    })

    it('不存在的任务 ID 应不影响状态', () => {
      const store = createTestStore()

      store.getState().appendAgentRunBlock('task-1', 'claude')
      store.getState().updateAgentRunBlock('nonexistent', { status: 'success' })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.status).toBe('running') // 状态不变
    })
  })

  describe('appendAgentToolCall', () => {
    it('应添加嵌套工具调用', () => {
      const store = createTestStore()

      store.getState().appendAgentRunBlock('task-1', 'claude')
      store.getState().appendAgentToolCall('task-1', 'tool-1', 'read_file')

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.toolCalls).toHaveLength(1)
      expect(block.toolCalls[0]).toMatchObject({
        id: 'tool-1',
        name: 'read_file',
        status: 'pending',
      })
    })

    it('应支持添加多个嵌套工具调用', () => {
      const store = createTestStore()

      store.getState().appendAgentRunBlock('task-1', 'claude')
      store.getState().appendAgentToolCall('task-1', 'tool-1', 'read_file')
      store.getState().appendAgentToolCall('task-1', 'tool-2', 'write_file')

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.toolCalls).toHaveLength(2)
    })

    it('不存在的任务 ID 应不影响状态', () => {
      const store = createTestStore()

      store.getState().appendAgentRunBlock('task-1', 'claude')
      store.getState().appendAgentToolCall('nonexistent', 'tool-1', 'read_file')

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.toolCalls).toHaveLength(0)
    })
  })

  describe('updateAgentToolCallStatus', () => {
    it('应更新嵌套工具调用状态', () => {
      const store = createTestStore()

      store.getState().appendAgentRunBlock('task-1', 'claude')
      store.getState().appendAgentToolCall('task-1', 'tool-1', 'read_file')
      store.getState().updateAgentToolCallStatus('task-1', 'tool-1', 'completed', 'Done')

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.toolCalls[0].status).toBe('completed')
      expect(block.toolCalls[0].summary).toBe('Done')
    })

    it('应支持多种状态', () => {
      const store = createTestStore()

      store.getState().appendAgentRunBlock('task-1', 'claude')
      store.getState().appendAgentToolCall('task-1', 'tool-1', 'read_file')

      const statuses: Array<'pending' | 'running' | 'completed' | 'failed'> = ['running', 'completed', 'failed']
      for (const status of statuses) {
        store.getState().updateAgentToolCallStatus('task-1', 'tool-1', status)
        const block = store.getState().currentMessage?.blocks[0] as any
        expect(block.toolCalls[0].status).toBe(status)
      }
    })
  })

  describe('setActiveTask', () => {
    it('应设置活跃任务 ID', () => {
      const store = createTestStore()

      store.getState().setActiveTask('task-123')
      expect(store.getState().activeTaskId).toBe('task-123')
    })

    it('应支持设置为 null', () => {
      const store = createTestStore()

      store.getState().setActiveTask('task-123')
      store.getState().setActiveTask(null)
      expect(store.getState().activeTaskId).toBeNull()
    })
  })

  // ========================================
  // ToolGroup 测试
  // ========================================
  describe('appendToolGroupBlock', () => {
    it('无 currentMessage 时应创建新消息', () => {
      const store = createTestStore()

      const tools = [
        { id: 'tool-1', name: 'read_file', status: 'completed' as const },
        { id: 'tool-2', name: 'write_file', status: 'running' as const },
      ]

      store.getState().appendToolGroupBlock('group-1', tools, '2 个工具')

      const { currentMessage, toolGroupBlockMap } = store.getState()
      expect(currentMessage).not.toBeNull()
      expect(currentMessage?.blocks).toHaveLength(1)
      expect(currentMessage?.blocks[0]).toMatchObject({
        type: 'tool_group',
        id: 'group-1',
        summary: '2 个工具',
        status: 'running', // 默认状态
      })
      expect(toolGroupBlockMap.get('group-1')).toBe(0)
    })

    it('应追加到现有消息', () => {
      const store = createTestStore()

      store.getState().appendTextBlock('Processing...')
      store.getState().appendToolGroupBlock('group-1', [])

      const { currentMessage, toolGroupBlockMap } = store.getState()
      expect(currentMessage?.blocks).toHaveLength(2)
      expect(currentMessage?.blocks[1]).toMatchObject({
        type: 'tool_group',
        id: 'group-1',
      })
      expect(toolGroupBlockMap.get('group-1')).toBe(1)
    })

    it('应正确设置工具列表', () => {
      const store = createTestStore()

      const tools = [
        { id: 'tool-1', name: 'read_file', status: 'completed' as const, startedAt: Date.now() },
        { id: 'tool-2', name: 'write_file', status: 'running' as const, startedAt: Date.now() },
      ]

      store.getState().appendToolGroupBlock('group-1', tools)

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.tools).toHaveLength(2)
      expect(block.tools[0]).toMatchObject({
        id: 'tool-1',
        name: 'read_file',
        status: 'completed',
      })
    })

    it('应提取工具名称列表', () => {
      const store = createTestStore()

      const tools = [
        { id: 'tool-1', name: 'read_file', status: 'running' as const },
        { id: 'tool-2', name: 'write_file', status: 'running' as const },
        { id: 'tool-3', name: 'read_file', status: 'running' as const },
      ]

      store.getState().appendToolGroupBlock('group-1', tools)

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.toolNames).toEqual(['read_file', 'write_file'])
    })
  })

  describe('updateToolGroupBlock', () => {
    it('应更新工具组状态', () => {
      const store = createTestStore()

      store.getState().appendToolGroupBlock('group-1', [])
      store.getState().updateToolGroupBlock('group-1', { status: 'completed' })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.status).toBe('completed')
    })

    it('应更新展开状态', () => {
      const store = createTestStore()

      store.getState().appendToolGroupBlock('group-1', [])
      store.getState().updateToolGroupBlock('group-1', { isExpanded: true })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.isExpanded).toBe(true)
    })

    it('应更新摘要', () => {
      const store = createTestStore()

      store.getState().appendToolGroupBlock('group-1', [])
      store.getState().updateToolGroupBlock('group-1', { summary: '更新后的摘要' })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.summary).toBe('更新后的摘要')
    })

    it('不存在的组 ID 应不影响状态', () => {
      const store = createTestStore()

      store.getState().appendToolGroupBlock('group-1', [])
      store.getState().updateToolGroupBlock('nonexistent', { status: 'completed' })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.status).toBe('running') // 状态不变
    })
  })

  describe('updateToolInGroup', () => {
    it('应更新组内单个工具状态', () => {
      const store = createTestStore()

      const tools = [
        { id: 'tool-1', name: 'read_file', status: 'running' as const },
      ]
      store.getState().appendToolGroupBlock('group-1', tools)
      store.getState().updateToolInGroup('group-1', 'tool-1', { status: 'completed' })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.tools[0].status).toBe('completed')
    })

    it('更新工具状态应触发聚合状态更新', () => {
      const store = createTestStore()

      const tools = [
        { id: 'tool-1', name: 'read_file', status: 'running' as const },
        { id: 'tool-2', name: 'write_file', status: 'running' as const },
      ]
      store.getState().appendToolGroupBlock('group-1', tools)

      // 更新第一个工具
      store.getState().updateToolInGroup('group-1', 'tool-1', { status: 'completed' })

      let block = store.getState().currentMessage?.blocks[0] as any
      expect(block.tools[0].status).toBe('completed')
      expect(block.status).toBe('running') // 还有运行中的

      // 更新第二个工具
      store.getState().updateToolInGroup('group-1', 'tool-2', { status: 'completed' })

      block = store.getState().currentMessage?.blocks[0] as any
      expect(block.tools[1].status).toBe('completed')
      expect(block.status).toBe('completed') // 全部完成
    })

    it('不存在的组 ID 应不影响状态', () => {
      const store = createTestStore()

      const tools = [{ id: 'tool-1', name: 'read_file', status: 'running' as const }]
      store.getState().appendToolGroupBlock('group-1', tools)
      store.getState().updateToolInGroup('nonexistent', 'tool-1', { status: 'completed' })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.tools[0].status).toBe('running')
    })

    it('不存在的工具 ID 应不影响状态', () => {
      const store = createTestStore()

      const tools = [{ id: 'tool-1', name: 'read_file', status: 'running' as const }]
      store.getState().appendToolGroupBlock('group-1', tools)
      store.getState().updateToolInGroup('group-1', 'nonexistent', { status: 'completed' })

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.tools[0].status).toBe('running')
    })
  })

  describe('setPendingToolGroup', () => {
    it('应设置待聚合工具组', () => {
      const store = createTestStore()

      const group = {
        groupId: 'group-1',
        tools: [{ id: 'tool-1', name: 'read_file', status: 'running' as const, startedAt: Date.now() }],
        startedAt: Date.now(),
        timerId: null as any,
      }

      store.getState().setPendingToolGroup(group)
      expect(store.getState().pendingToolGroup).toEqual(group)
    })

    it('应支持设置为 null', () => {
      const store = createTestStore()

      const group = {
        groupId: 'group-1',
        tools: [],
        startedAt: Date.now(),
        timerId: null as any,
      }

      store.getState().setPendingToolGroup(group)
      store.getState().setPendingToolGroup(null)
      expect(store.getState().pendingToolGroup).toBeNull()
    })
  })

  describe('addToolToPendingGroup', () => {
    it('无待聚合组时应创建新组', () => {
      const store = createTestStore()

      store.getState().addToolToPendingGroup({
        id: 'tool-1',
        name: 'read_file',
        startedAt: Date.now(),
      })

      const { pendingToolGroup } = store.getState()
      expect(pendingToolGroup).not.toBeNull()
      expect(pendingToolGroup?.tools).toHaveLength(1)
      expect(pendingToolGroup?.tools[0]).toMatchObject({
        id: 'tool-1',
        name: 'read_file',
        status: 'running',
      })
    })

    it('应追加到现有待聚合组', () => {
      const store = createTestStore()

      store.getState().addToolToPendingGroup({
        id: 'tool-1',
        name: 'read_file',
        startedAt: Date.now(),
      })
      store.getState().addToolToPendingGroup({
        id: 'tool-2',
        name: 'write_file',
        startedAt: Date.now(),
      })

      const { pendingToolGroup } = store.getState()
      expect(pendingToolGroup?.tools).toHaveLength(2)
    })
  })

  describe('finalizePendingToolGroup', () => {
    it('工具数不足 2 时不创建组', () => {
      const store = createTestStore()

      store.getState().addToolToPendingGroup({
        id: 'tool-1',
        name: 'read_file',
        startedAt: Date.now(),
      })
      store.getState().finalizePendingToolGroup()

      const { currentMessage, pendingToolGroup } = store.getState()
      expect(currentMessage).toBeNull()
      expect(pendingToolGroup).toBeNull()
    })

    it('工具数 >= 2 时应创建 ToolGroupBlock', () => {
      const store = createTestStore()

      store.getState().addToolToPendingGroup({
        id: 'tool-1',
        name: 'read_file',
        startedAt: Date.now(),
      })
      store.getState().addToolToPendingGroup({
        id: 'tool-2',
        name: 'write_file',
        startedAt: Date.now(),
      })
      store.getState().finalizePendingToolGroup()

      const { currentMessage, pendingToolGroup, toolGroupBlockMap } = store.getState()
      expect(currentMessage).not.toBeNull()
      expect(currentMessage?.blocks).toHaveLength(1)
      expect(currentMessage?.blocks[0]).toMatchObject({
        type: 'tool_group',
        tools: expect.arrayContaining([
          expect.objectContaining({ id: 'tool-1', name: 'read_file' }),
          expect.objectContaining({ id: 'tool-2', name: 'write_file' }),
        ]),
      })
      expect(pendingToolGroup).toBeNull()
      expect(toolGroupBlockMap.size).toBe(1)
    })

    it('无待聚合组时应安全处理', () => {
      const store = createTestStore()

      store.getState().finalizePendingToolGroup()

      const { currentMessage, pendingToolGroup } = store.getState()
      expect(currentMessage).toBeNull()
      expect(pendingToolGroup).toBeNull()
    })

    it('相同工具名应显示计数', () => {
      const store = createTestStore()

      store.getState().addToolToPendingGroup({
        id: 'tool-1',
        name: 'read_file',
        startedAt: Date.now(),
      })
      store.getState().addToolToPendingGroup({
        id: 'tool-2',
        name: 'read_file',
        startedAt: Date.now(),
      })
      store.getState().finalizePendingToolGroup()

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.summary).toBe('read_file ×2')
    })

    it('不同工具名应显示数量', () => {
      const store = createTestStore()

      store.getState().addToolToPendingGroup({
        id: 'tool-1',
        name: 'read_file',
        startedAt: Date.now(),
      })
      store.getState().addToolToPendingGroup({
        id: 'tool-2',
        name: 'write_file',
        startedAt: Date.now(),
      })
      store.getState().finalizePendingToolGroup()

      const block = store.getState().currentMessage?.blocks[0] as any
      expect(block.summary).toBe('2 个工具')
    })
  })
})
