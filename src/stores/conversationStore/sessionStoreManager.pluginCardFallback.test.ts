/**
 * plugin_card 兜底投递测试 —— cap.ui.render 外部入口失效修复（方案 C）
 *
 * 场景：外部入口（MCP bridge / cap_dispatch）调用 cap.ui.render request 时，
 * 事件携带的 routeSessionId 是后端 conversationId，对不上任何前端 store。
 * dispatchEvent 需对实体渲染事件（plugin_card / plugin_card_answered）
 * 兜底投递到当前活跃会话，使卡片能渲染、可交互、可回写。
 *
 * 非白名单事件与无活跃会话时维持原丢弃语义。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { sessionStoreManager } from './sessionStoreManager'
import type { PluginCardEvent } from '@/ai-runtime/event'

describe('plugin_card 外部入口兜底投递', () => {
  beforeEach(() => {
    const state = sessionStoreManager.getState()
    const sessionIds = Array.from(state.stores.keys())
    sessionIds.forEach((id) => state.deleteSession(id))
  })

  /** 构造一个 plugin_card 事件（模拟 cap.ui.render request 广播） */
  const makeCardEvent = (routeSessionId: string, interactionId = 'card-1'): PluginCardEvent & { _routeSessionId: string } => ({
    type: 'plugin_card',
    sessionId: 'backend-conversation-id',
    interactionId,
    pluginId: 'demo',
    cardId: 'render-test',
    toolName: 'mcp__demo__render_test',
    payload: { title: 'Hello', frame: {} },
    _routeSessionId: routeSessionId,
  })

  /** 读取某会话 store 中的 plugin_card blocks */
  const cardBlocks = (sessionId: string) => {
    const store = sessionStoreManager.getState().stores.get(sessionId)
    const state = store?.getState()
    return state?.currentMessage?.blocks.filter((b) => b.type === 'plugin_card') ?? []
  }

  it('正常路径：plugin_card 匹配到对应 store 时投递到该 store，不兜底', () => {
    const targetId = sessionStoreManager.getState().createSession({ type: 'free', title: 'Target' })

    sessionStoreManager.getState().dispatchEvent(makeCardEvent(targetId))

    const blocks = cardBlocks(targetId)
    expect(blocks.length).toBe(1)
    expect(blocks[0]).toMatchObject({ type: 'plugin_card', id: 'card-1' })
  })

  it('兜底路径：plugin_card 未匹配任何 store 时投递到活跃会话', () => {
    // 活跃会话（createSession 非静默自动设为 activeSessionId）
    const activeId = sessionStoreManager.getState().createSession({ type: 'free', title: 'Active' })
    // 外部携带的后端 conversationId，对不上任何前端 store
    const externalId = 'backend-conversation-id-xyz'

    sessionStoreManager.getState().dispatchEvent(makeCardEvent(externalId))

    // 卡片应出现在活跃会话
    const blocks = cardBlocks(activeId)
    expect(blocks.length).toBe(1)
    expect(blocks[0]).toMatchObject({ type: 'plugin_card', id: 'card-1' })
  })

  it('兜底路径：plugin_card 没有静默会话时也能投递', () => {
    // 明确测试：activeId 判断为活跃会话，即使存在第二个会话
    const activeId = sessionStoreManager.getState().createSession({ type: 'free', title: 'Active' })
    sessionStoreManager.getState().createSession({ type: 'free', title: 'Background', silentMode: true })

    sessionStoreManager.getState().dispatchEvent(makeCardEvent('no-such-store'))

    const blocks = cardBlocks(activeId)
    expect(blocks.length).toBe(1)
  })

  it('兜底路径：plugin_card_answered 同样兜底并可回写卡片状态', () => {
    const activeId = sessionStoreManager.getState().createSession({ type: 'free', title: 'Active' })
    const externalId = 'backend-conversation-id-xyz'

    // 先兜底投递 plugin_card
    sessionStoreManager.getState().dispatchEvent(makeCardEvent(externalId, 'card-42'))
    let blocks = cardBlocks(activeId)
    expect(blocks.length).toBe(1)
    expect(blocks[0]).toMatchObject({ id: 'card-42', status: 'pending' })

    // 再兜底投递 plugin_card_answered → 状态应回写为 answered
    sessionStoreManager.getState().dispatchEvent({
      type: 'plugin_card_answered',
      sessionId: 'backend-conversation-id',
      interactionId: 'card-42',
      declined: false,
      result: { ok: true },
      _routeSessionId: externalId,
    })

    blocks = cardBlocks(activeId)
    expect(blocks.length).toBe(1)
    expect(blocks[0]).toMatchObject({ id: 'card-42', status: 'answered', response: { ok: true } })
  })

  it('兜底路径：activeSessionId 为 null（无活跃会话）时维持丢弃语义', () => {
    // 创建一个会话后删除它 → activeSessionId 置 null
    const tempId = sessionStoreManager.getState().createSession({ type: 'free', title: 'Temp' })
    sessionStoreManager.getState().deleteSession(tempId)

    expect(sessionStoreManager.getState().activeSessionId).toBeNull()

    sessionStoreManager.getState().dispatchEvent(makeCardEvent('no-such-store'))

    // 没有任何 store 收到卡片
    const stores = sessionStoreManager.getState().stores
    expect(stores.size).toBe(0)
  })

  it('非白名单事件不兜底：result 事件未匹配 store 时维持丢弃语义', () => {
    const activeId = sessionStoreManager.getState().createSession({ type: 'free', title: 'Active' })

    // result 事件携带外部 routeSessionId，应被丢弃而非兜底到活跃会话
    sessionStoreManager.getState().dispatchEvent({
      type: 'result',
      output: 'hello',
      sessionId: 'backend-conversation-id',
      _routeSessionId: 'no-such-store',
    })

    const store = sessionStoreManager.getState().stores.get(activeId)
    const state = store?.getState()
    // result 未写入活跃会话（message 应保持空）
    expect(state?.messages.length ?? 0).toBe(0)
  })
})