/**
 * ExecutionConsoleStore 单元测试
 *
 * 验证集成 AI 执行事件序列的聚合逻辑：
 * message → delta → complete/error，以及历史上限与清理。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock transport：捕获各事件的 handler，返回可断言的 unlisten
const listenHandlers = new Map<string, (payload: unknown) => void>()
const unlistenFns = new Map<string, ReturnType<typeof vi.fn>>()

vi.mock('@/services/transport', () => ({
  listen: vi.fn((event: string, handler: (payload: unknown) => void) => {
    listenHandlers.set(event, handler)
    const unlisten = vi.fn()
    unlistenFns.set(event, unlisten)
    return Promise.resolve(unlisten)
  }),
}))

import { useExecutionConsoleStore, selectActiveIntegrationRuns } from './executionConsoleStore'
import { HISTORY_MAX_ENTRIES, toPreview, PREVIEW_MAX_LENGTH } from '@/types/executionConsole'
import type { IntegrationMessage } from '@/types'

function makeMessage(overrides: Partial<IntegrationMessage> = {}): IntegrationMessage {
  return {
    id: 'msg-1',
    platform: 'qqbot',
    conversationId: 'conv-1',
    senderId: 'user-1',
    senderName: '测试用户',
    content: { type: 'text', text: '帮我看看今天的日程' },
    timestamp: Date.now(),
    ...overrides,
  }
}

function resetStore() {
  useExecutionConsoleStore.setState({
    integrationRuns: new Map(),
    history: [],
    initialized: false,
    _unlistenFns: [],
  })
}

describe('executionConsoleStore', () => {
  beforeEach(() => {
    listenHandlers.clear()
    unlistenFns.clear()
    vi.clearAllMocks()
    resetStore()
  })

  describe('initialize / cleanup', () => {
    it('安装 4 个集成事件监听器且幂等', async () => {
      const store = useExecutionConsoleStore.getState()
      await store.initialize()

      expect(listenHandlers.has('integration:message')).toBe(true)
      expect(listenHandlers.has('integration:ai:delta')).toBe(true)
      expect(listenHandlers.has('integration:ai:complete')).toBe(true)
      expect(listenHandlers.has('integration:ai:error')).toBe(true)
      expect(useExecutionConsoleStore.getState().initialized).toBe(true)

      // 幂等：重复调用不重复安装
      const { listen } = await import('@/services/transport')
      const callCount = vi.mocked(listen).mock.calls.length
      await useExecutionConsoleStore.getState().initialize()
      expect(vi.mocked(listen).mock.calls.length).toBe(callCount)
    })

    it('cleanup 调用全部 unlisten 并复位状态', async () => {
      await useExecutionConsoleStore.getState().initialize()
      useExecutionConsoleStore.getState().cleanup()

      for (const unlisten of unlistenFns.values()) {
        expect(unlisten).toHaveBeenCalledTimes(1)
      }
      expect(useExecutionConsoleStore.getState().initialized).toBe(false)
      expect(useExecutionConsoleStore.getState()._unlistenFns).toHaveLength(0)
    })
  })

  describe('集成事件序列', () => {
    it('message 事件登记 running 执行', () => {
      useExecutionConsoleStore.getState()._onIntegrationMessage(makeMessage())

      const state = useExecutionConsoleStore.getState()
      const run = state.integrationRuns.get('conv-1')
      expect(run).toBeDefined()
      expect(run?.status).toBe('running')
      expect(run?.platform).toBe('qqbot')
      expect(run?.senderName).toBe('测试用户')
      expect(run?.promptPreview).toBe('帮我看看今天的日程')
      expect(selectActiveIntegrationRuns(state)).toHaveLength(1)
    })

    it('delta 事件更新输出预览与活动时间', () => {
      const store = useExecutionConsoleStore.getState()
      store._onIntegrationMessage(makeMessage())
      store._onIntegrationAiDelta({ conversationId: 'conv-1', text: '正在查询日程…' })

      const run = useExecutionConsoleStore.getState().integrationRuns.get('conv-1')
      expect(run?.lastOutputPreview).toBe('正在查询日程…')
      expect(run?.status).toBe('running')
    })

    it('未知 conversationId 的 delta 被忽略', () => {
      useExecutionConsoleStore.getState()._onIntegrationAiDelta({ conversationId: 'ghost', text: 'x' })
      expect(useExecutionConsoleStore.getState().integrationRuns.size).toBe(0)
    })

    it('complete 事件标记成功并写入历史', () => {
      const store = useExecutionConsoleStore.getState()
      store._onIntegrationMessage(makeMessage())
      store._onIntegrationAiComplete({
        conversationId: 'conv-1',
        sessionId: 'sess-abc',
        text: '今天有 3 个会议',
      })

      const state = useExecutionConsoleStore.getState()
      const run = state.integrationRuns.get('conv-1')
      expect(run?.status).toBe('success')
      expect(run?.sessionId).toBe('sess-abc')
      expect(run?.endedAt).toBeDefined()
      expect(selectActiveIntegrationRuns(state)).toHaveLength(0)

      expect(state.history).toHaveLength(1)
      expect(state.history[0].origin).toBe('integration')
      expect(state.history[0].status).toBe('success')
      expect(state.history[0].title).toBe('测试用户')
      expect(state.history[0].summary).toBe('今天有 3 个会议')
    })

    it('error 事件标记失败并写入含错误的历史', () => {
      const store = useExecutionConsoleStore.getState()
      store._onIntegrationMessage(makeMessage())
      store._onIntegrationAiError({ conversationId: 'conv-1', error: 'AI 调用失败' })

      const state = useExecutionConsoleStore.getState()
      expect(state.integrationRuns.get('conv-1')?.status).toBe('failed')
      expect(state.integrationRuns.get('conv-1')?.error).toBe('AI 调用失败')

      expect(state.history).toHaveLength(1)
      expect(state.history[0].status).toBe('failed')
      expect(state.history[0].error).toBe('AI 调用失败')
    })

    it('无前置 message 的 complete 也写入历史（容错）', () => {
      useExecutionConsoleStore.getState()._onIntegrationAiComplete({
        conversationId: 'conv-x',
        text: '回复内容',
      })
      const state = useExecutionConsoleStore.getState()
      expect(state.history).toHaveLength(1)
      expect(state.history[0].title).toBe('conv-x')
    })

    it('同会话第二条消息复用条目并重置为 running', () => {
      const store = useExecutionConsoleStore.getState()
      store._onIntegrationMessage(makeMessage())
      store._onIntegrationAiComplete({ conversationId: 'conv-1', text: '完成' })
      store._onIntegrationMessage(makeMessage({ content: { type: 'text', text: '第二个问题' } }))

      const state = useExecutionConsoleStore.getState()
      expect(state.integrationRuns.size).toBe(1)
      const run = state.integrationRuns.get('conv-1')
      expect(run?.status).toBe('running')
      expect(run?.promptPreview).toBe('第二个问题')
      expect(run?.endedAt).toBeUndefined()
    })
  })

  describe('历史管理', () => {
    it('历史裁剪到上限且新条目在前', () => {
      const store = useExecutionConsoleStore.getState()
      for (let i = 0; i < HISTORY_MAX_ENTRIES + 5; i++) {
        store.addHistoryEntry({
          id: `entry-${i}`,
          origin: 'integration',
          title: `t${i}`,
          summary: '',
          status: 'success',
          startedAt: i,
          endedAt: i,
        })
      }
      const history = useExecutionConsoleStore.getState().history
      expect(history).toHaveLength(HISTORY_MAX_ENTRIES)
      expect(history[0].id).toBe(`entry-${HISTORY_MAX_ENTRIES + 4}`)
    })

    it('clearHistory 清空历史', () => {
      const store = useExecutionConsoleStore.getState()
      store.addHistoryEntry({
        id: 'e1', origin: 'integration', title: 't', summary: '',
        status: 'success', startedAt: 0, endedAt: 0,
      })
      store.clearHistory()
      expect(useExecutionConsoleStore.getState().history).toHaveLength(0)
    })
  })

  describe('toPreview', () => {
    it('压缩空白并截断超长文本', () => {
      expect(toPreview('  hello   world  ')).toBe('hello world')
      const long = 'a'.repeat(PREVIEW_MAX_LENGTH + 50)
      const preview = toPreview(long)
      expect(preview.length).toBe(PREVIEW_MAX_LENGTH + 1) // 含省略号
      expect(preview.endsWith('…')).toBe(true)
    })
  })
})
