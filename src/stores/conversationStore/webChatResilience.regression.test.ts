import { describe, expect, it } from 'vitest'
import { createConversationStore } from './createConversationStore'
import type { AIEvent } from '../../ai-runtime'
import type { StoreDeps } from './types'

function createDeps(): StoreDeps {
  return {
    getConfig: () => ({ defaultEngine: 'custom-engine' }),
    getWorkspace: () => null,
    getContextWorkspaceIds: () => [],
    getAllWorkspaces: () => [],
    getEventRouter: () => ({}) as StoreDeps['getEventRouter'] extends () => infer T ? T : never,
    contextId: 'test-context',
  }
}

/**
 * Web 端会话韧性回归测试（问题清单验证）
 *
 * #7 工具卡永不结束：
 *   tool_call_start 无 callId 时前端生成 UUID 建块，但 tool_call_end 无 callId 时
 *   eventHandler 用空串 '' 查 toolBlockMap → 找不到块 → 工具卡永远停留在 running。
 *   （引擎侧流式事件不携带 callId 的典型场景）
 *
 * #8 断线重放 token 文本重复：
 *   token / assistant_message 为纯 appendTextBlock，resume 补发 / 快照重放同一段
 *   token 时文本重复累积，无幂等水位可截断。
 */
describe('web chat resilience regression', () => {
  describe('#7 tool_call_end without callId must complete the generated tool block', () => {
    it('completes the running tool block when both start/end omit callId', () => {
      const store = createConversationStore('session-1', createDeps())

      // 引擎流式事件不携带 callId：start 由前端生成 UUID 建立块
      store.getState().handleAIEvent({
        type: 'tool_call_start',
        sessionId: 'backend-session',
        tool: 'bash',
        args: { command: 'ls' },
      } satisfies AIEvent)

      const blocks = store.getState().currentMessage?.blocks
      expect(blocks).toHaveLength(1)
      expect(blocks?.[0]).toMatchObject({ type: 'tool_call', status: 'running' })

      // 同样不携带 callId 的 end：期望找到先前生成的块并置为 completed
      store.getState().handleAIEvent({
        type: 'tool_call_end',
        sessionId: 'backend-session',
        tool: 'bash',
        success: true,
        result: { output: 'ok' },
      } satisfies AIEvent)

      const afterEnd = store.getState().currentMessage?.blocks?.[0]
      expect(afterEnd).toMatchObject({ type: 'tool_call', status: 'completed' })
      // 输出回填
      expect(afterEnd).toMatchObject({ output: expect.stringContaining('ok') })
    })

    it('still completes the exact block by callId when callId is present (control case)', () => {
      const store = createConversationStore('session-1', createDeps())

      store.getState().handleAIEvent({
        type: 'tool_call_start',
        sessionId: 'backend-session',
        callId: 'item_1',
        tool: 'bash',
        args: { command: 'ls' },
      } satisfies AIEvent)

      store.getState().handleAIEvent({
        type: 'tool_call_end',
        sessionId: 'backend-session',
        callId: 'item_1',
        tool: 'bash',
        success: true,
        result: { output: 'ok' },
      } satisfies AIEvent)

      expect(store.getState().currentMessage?.blocks?.[0]).toMatchObject({
        type: 'tool_call',
        id: 'item_1',
        status: 'completed',
      })
    })
  })

  describe('#8 token replay deduplication moved to backend (EventBroadcaster seq)', () => {
    it('frontend appends token text as-is (dedup is backend EventBroadcaster responsibility)', () => {
      const store = createConversationStore('session-1', createDeps())

      store.getState().handleAIEvent({ type: 'session_start', sessionId: 'backend-session' } satisfies AIEvent)

      store.getState().handleAIEvent({
        type: 'token',
        sessionId: 'backend-session',
        value: 'hello\n\n',
      } satisfies AIEvent)

      const firstContent = textOf(store)
      expect(firstContent).toBe('hello\n\n')

      // 前端不再做文本去重——重放去重由后端 EventBroadcaster 的 seq + replay_after 保证。
      // 重复 dispatch 会追加（前端只是渲染缓存），但这不会在正常路径发生（后端按 seq 补发）。
      store.getState().handleAIEvent({
        type: 'token',
        sessionId: 'backend-session',
        value: 'hello\n\n',
      } satisfies AIEvent)

      expect(textOf(store)).toBe('hello\n\nhello\n\n')
    })

    it('assistant_message appends as-is (dedup is backend responsibility)', () => {
      const store = createConversationStore('session-1', createDeps())

      store.getState().handleAIEvent({ type: 'session_start', sessionId: 'backend-session' } satisfies AIEvent)

      store.getState().handleAIEvent({
        type: 'assistant_message',
        sessionId: 'backend-session',
        content: 'reply\n\n',
        isDelta: false,
      } satisfies AIEvent)
      expect(textOf(store)).toBe('reply\n\n')
    })
  })
})

function textOf(store: ReturnType<typeof createConversationStore>): string {
  const current = store.getState().currentMessage
  const text = current?.blocks?.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.content : ''))
  return text?.join('') ?? ''
}