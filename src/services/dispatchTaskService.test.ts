/**
 * dispatchTaskService 单元测试
 *
 * 验证派发请求的核心前端流程：
 * - 静默会话创建（不抢占当前 Tab）+ 加入后台列表（获得完成通知与 LRU 保护）
 * - start_chat 以 dispatch- contextId 启动，engineId/workDir 继承来源会话
 * - 启动成功回报 running；session_end 回报 completed；启动失败回报 failed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()

vi.mock('@/services/transport', () => ({
  listen: vi.fn(() => Promise.resolve(vi.fn())),
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, arg?: unknown) => {
      if (typeof arg === 'string') return arg
      if (arg && typeof arg === 'object' && 'defaultValue' in (arg as Record<string, unknown>)) {
        return String((arg as Record<string, unknown>).defaultValue)
      }
      return key
    },
  },
}))

import { handleDispatchTaskRequest, continueDispatchedTask, parseDispatchSlashCommand } from './dispatchTaskService'
import { sessionStoreManager } from '@/stores/conversationStore'
import { getEventRouter, resetEventRouter } from '@/services/eventRouter'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useDispatchStore } from '@/stores/dispatchStore'

function resetManager() {
  sessionStoreManager.setState({
    stores: new Map(),
    sessionMetadata: new Map(),
    activeSessionId: null,
    backgroundSessionIds: [],
    completedNotifications: [],
    conversationIdToStoreId: new Map(),
  })
  useDispatchStore.setState({ tasks: new Map(), pendingReports: new Map() })
}

describe('dispatchTaskService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetEventRouter()
    resetManager()
    invokeMock.mockResolvedValue('backend-conv-1')
  })

  it('creates a silent background session and starts chat with dispatch contextId', async () => {
    await handleDispatchTaskRequest({
      dispatchId: 'd-1',
      sessionId: 'dispatch-1-abc12345',
      sourceSessionId: '',
      prompt: '跑一遍回归测试',
      title: '测试任务',
      workDir: 'D:/work/demo',
    })

    const state = sessionStoreManager.getState()
    expect(state.stores.has('dispatch-1-abc12345')).toBe(true)
    // 静默：不抢占当前活跃会话
    expect(state.activeSessionId).toBeNull()
    const meta = state.sessionMetadata.get('dispatch-1-abc12345')
    expect(meta?.silentMode).toBe(true)
    expect(meta?.title).toBe('测试任务')
    // 后台列表：获得完成通知 + LRU 驱逐保护
    expect(state.backgroundSessionIds).toContain('dispatch-1-abc12345')

    // start_chat 参数
    const startCall = invokeMock.mock.calls.find((c) => c[0] === 'start_chat')
    expect(startCall).toBeDefined()
    const [, payload] = startCall as [string, { message: string; options: Record<string, unknown> }]
    expect(payload.message).toBe('跑一遍回归测试')
    expect(payload.options.contextId).toBe('dispatch-1-abc12345')
    expect(payload.options.workDir).toBe('D:/work/demo')
    expect(payload.options.enableMcpTools).toBe(true)

    // 启动成功后回报 running
    const reportCall = invokeMock.mock.calls.find((c) => c[0] === 'dispatch_report_status')
    expect(reportCall?.[1]).toMatchObject({ dispatchId: 'd-1', status: 'running' })
  })

  it('inherits engine and workspace from the source session', async () => {
    useWorkspaceStore.setState({
      workspaces: [
        { id: 'ws-1', name: 'demo', path: 'D:/work/source-ws' },
      ] as never,
    })
    sessionStoreManager.getState().createSession({
      id: 'source-session',
      type: 'project',
      workspaceId: 'ws-1',
      engineId: 'codex',
    })

    await handleDispatchTaskRequest({
      dispatchId: 'd-2',
      sessionId: 'dispatch-1-def67890',
      sourceSessionId: 'source-session',
      prompt: '做点事',
    })

    const startCall = invokeMock.mock.calls.find((c) => c[0] === 'start_chat')
    const [, payload] = startCall as [string, { options: Record<string, unknown> }]
    expect(payload.options.engineId).toBe('codex')
    expect(payload.options.workDir).toBe('D:/work/source-ws')
  })

  it('reports completed with summary on session_end', async () => {
    await handleDispatchTaskRequest({
      dispatchId: 'd-3',
      sessionId: 'dispatch-1-aaa11111',
      prompt: '任务',
    })

    // 通过注册的 contextId handler 模拟事件回流
    const router = getEventRouter()
    const store = sessionStoreManager.getState().stores.get('dispatch-1-aaa11111')
    expect(store).toBeDefined()

    // 直接注入一条助手消息作为摘要来源
    store!.setState({
      messages: [
        {
          id: 'm1',
          type: 'assistant',
          timestamp: new Date().toISOString(),
          blocks: [{ type: 'text', content: '测试全部通过' }],
        },
      ] as never,
    })

    invokeMock.mockClear()
    // handler 已在 handleDispatchTaskRequest 中注册；dispatch 一条 session_end
    ;(router as unknown as { dispatch: (e: { contextId: string; payload: unknown }) => void })[
      'dispatch'
    ]({
      contextId: 'dispatch-1-aaa11111',
      payload: { type: 'session_end', reason: 'completed' },
    })

    // reportStatus 为异步 fire-and-forget，等微任务清空
    await Promise.resolve()

    const reportCall = invokeMock.mock.calls.find((c) => c[0] === 'dispatch_report_status')
    expect(reportCall?.[1]).toMatchObject({
      dispatchId: 'd-3',
      status: 'completed',
      summary: '测试全部通过',
    })

    // dispatchStore：任务终态 + 报告入队（结果回流数据源）
    const task = useDispatchStore.getState().getTask('d-3')
    expect(task?.status).toBe('completed')
    expect(task?.summary).toBe('测试全部通过')
  })

  it('queues a report for the source session on completion (result backflow)', async () => {
    await handleDispatchTaskRequest({
      dispatchId: 'd-6',
      sessionId: 'dispatch-1-eee55555',
      sourceSessionId: 'source-abc',
      prompt: '任务',
      title: '回归测试',
    })

    const router = getEventRouter()
    ;(router as unknown as { dispatch: (e: { contextId: string; payload: unknown }) => void })[
      'dispatch'
    ]({
      contextId: 'dispatch-1-eee55555',
      payload: { type: 'session_end', reason: 'completed' },
    })

    const dispatchStore = useDispatchStore.getState()
    expect(dispatchStore.hasReports('source-abc')).toBe(true)
    const reports = dispatchStore.takeReports('source-abc')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ dispatchId: 'd-6', title: '回归测试', status: 'completed' })
    // 消费即清
    expect(useDispatchStore.getState().hasReports('source-abc')).toBe(false)
  })

  it('continues a finished dispatched task in the same session', async () => {
    await handleDispatchTaskRequest({
      dispatchId: 'd-7',
      sessionId: 'dispatch-1-fff66666',
      prompt: '任务',
    })
    const store = sessionStoreManager.getState().stores.get('dispatch-1-fff66666')
    store!.setState({ conversationId: 'backend-conv-7' })

    // 先结束任务
    const router = getEventRouter()
    ;(router as unknown as { dispatch: (e: { contextId: string; payload: unknown }) => void })[
      'dispatch'
    ]({
      contextId: 'dispatch-1-fff66666',
      payload: { type: 'session_end', reason: 'completed' },
    })
    expect(useDispatchStore.getState().getTask('d-7')?.status).toBe('completed')

    invokeMock.mockClear()
    invokeMock.mockResolvedValue(null)
    const ok = await continueDispatchedTask('d-7', '再复测一遍')
    expect(ok).toBe(true)

    const continueCall = invokeMock.mock.calls.find((c) => c[0] === 'continue_chat')
    expect(continueCall).toBeDefined()
    const [, payload] = continueCall as [string, { sessionId: string; message: string; options: Record<string, unknown> }]
    expect(payload.sessionId).toBe('backend-conv-7')
    expect(payload.message).toBe('再复测一遍')
    expect(payload.options.contextId).toBe('dispatch-1-fff66666')
    expect(useDispatchStore.getState().getTask('d-7')?.status).toBe('running')
  })

  it('refuses to continue a running task', async () => {
    await handleDispatchTaskRequest({
      dispatchId: 'd-8',
      sessionId: 'dispatch-1-ggg77777',
      prompt: '任务',
    })
    expect(useDispatchStore.getState().getTask('d-8')?.status).toBe('running')

    invokeMock.mockClear()
    const ok = await continueDispatchedTask('d-8', '插队指令')
    expect(ok).toBe(false)
    expect(invokeMock.mock.calls.find((c) => c[0] === 'continue_chat')).toBeUndefined()
  })

  it('reports failed when start_chat throws', async () => {
    invokeMock.mockImplementation((cmd: unknown) => {
      if (cmd === 'start_chat') return Promise.reject(new Error('engine boom'))
      return Promise.resolve(null)
    })

    await handleDispatchTaskRequest({
      dispatchId: 'd-4',
      sessionId: 'dispatch-1-bbb22222',
      prompt: '任务',
    })

    const reportCall = invokeMock.mock.calls.find((c) => c[0] === 'dispatch_report_status')
    expect(reportCall?.[1]).toMatchObject({
      dispatchId: 'd-4',
      status: 'failed',
      summary: 'engine boom',
    })
  })

  it('ignores requests with missing required fields', async () => {
    await handleDispatchTaskRequest({
      dispatchId: '',
      sessionId: 'dispatch-1-ccc33333',
      prompt: 'x',
    })
    expect(sessionStoreManager.getState().stores.size).toBe(0)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  describe('parseDispatchSlashCommand', () => {
    it('parses plain command with prompt', () => {
      expect(parseDispatchSlashCommand('/dispatch 跑全量测试')).toEqual({
        role: undefined,
        prompt: '跑全量测试',
      })
    })

    it('parses @role syntax', () => {
      expect(parseDispatchSlashCommand('/dispatch @测试员 回归验证登录模块')).toEqual({
        role: '测试员',
        prompt: '回归验证登录模块',
      })
    })

    it('handles role without prompt and bare command', () => {
      expect(parseDispatchSlashCommand('/dispatch @测试员')).toEqual({ role: '测试员', prompt: '' })
      expect(parseDispatchSlashCommand('/dispatch')).toEqual({ role: undefined, prompt: '' })
    })

    it('rejects non-dispatch text', () => {
      expect(parseDispatchSlashCommand('/dispatchxxx 任务')).toBeNull()
      expect(parseDispatchSlashCommand('普通消息 /dispatch')).toBeNull()
      expect(parseDispatchSlashCommand('/compact')).toBeNull()
    })
  })
})
