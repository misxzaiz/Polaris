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

describe('conversation form block', () => {
  it('appends a pending form block on the form event (schema-driven)', () => {
    const store = createConversationStore('session-1', createDeps())

    store.getState().handleAIEvent({
      type: 'form',
      sessionId: 'frontend-session-1',
      formId: 'form-1',
      title: '新建任务',
      read: 'full',
      target: 'cap.todo',
      action: 'create',
      fields: [
        { name: 'content', type: 'string', required: true },
        { name: 'priority', type: 'select', options: ['high', 'low'] },
        { name: 'apiKey', type: 'string', secret: true },
      ],
    } satisfies AIEvent)

    const block = store.getState().currentMessage?.blocks[0]
    expect(block).toMatchObject({
      type: 'form',
      id: 'form-1',
      sessionId: 'frontend-session-1',
      title: '新建任务',
      read: 'full',
      target: 'cap.todo',
      action: 'create',
      status: 'pending',
    })
    expect(block).toHaveProperty('fields')
    const fields = (block as { fields: unknown[] }).fields
    expect(fields).toHaveLength(3)
    expect(fields[2]).toMatchObject({ name: 'apiKey', secret: true })
  })

  it('normalizes read=none form and updates to submitted on form-answered', () => {
    const store = createConversationStore('session-1', createDeps())

    store.getState().handleAIEvent({
      type: 'form',
      sessionId: 'frontend-session-1',
      formId: 'form-2',
      title: '隐私表单',
      read: 'none',
      target: 'cap.kv',
      action: 'set',
      fields: [{ name: 'secretValue', type: 'secret' }],
    } satisfies AIEvent)

    const pending = store.getState().currentMessage?.blocks[0] as { read: string }
    expect(pending.read).toBe('none')

    store.getState().handleAIEvent({
      type: 'form-answered',
      sessionId: 'frontend-session-1',
      formId: 'form-2',
      ok: true,
      receipt: 'cap.kv.set ok',
    } satisfies AIEvent)

    const block = store.getState().currentMessage?.blocks[0]
    expect(block).toMatchObject({
      type: 'form',
      id: 'form-2',
      status: 'submitted',
      ok: true,
      receipt: 'cap.kv.set ok',
    })
  })

  it('marks pending forms as failed on history restore (hold lost after restart)', () => {
    const store = createConversationStore('session-1', createDeps())

    store.getState().handleAIEvent({
      type: 'form',
      sessionId: 'frontend-session-1',
      formId: 'form-3',
      target: 'cap.todo',
      action: 'create',
      fields: [{ name: 'content', type: 'string' }],
    } satisfies AIEvent)

    // 模拟历史恢复：把内存 currentMessage 清掉，用 setMessagesFromHistory 恢复
    const restoreBlocks = store.getState().currentMessage?.blocks ?? []
    store.getState().setMessagesFromHistory(
      [
        {
          id: 'msg-1',
          type: 'assistant',
          timestamp: new Date().toISOString(),
          blocks: restoreBlocks,
        },
      ],
      'session-1',
      null
    )

    const block = store.getState().messages[0]?.type === 'assistant'
      ? store.getState().messages[0].blocks.find(b => b.type === 'form')
      : null
    expect(block).toMatchObject({
      type: 'form',
      id: 'form-3',
      status: 'submitted',
      ok: false,
    })
  })

  it('is idempotent: duplicate form events do not append twice', () => {
    const store = createConversationStore('session-1', createDeps())

    const formEvent = {
      type: 'form',
      sessionId: 'frontend-session-1',
      formId: 'form-4',
      target: 'cap.todo',
      action: 'create',
      fields: [{ name: 'content', type: 'string' }],
    } satisfies AIEvent

    store.getState().handleAIEvent(formEvent)
    store.getState().handleAIEvent(formEvent)

    const blocks = store.getState().currentMessage?.blocks ?? []
    const formBlocks = blocks.filter(b => b.type === 'form')
    expect(formBlocks).toHaveLength(1)
  })

  // Bug 2 回归：form 事件到达后 AI 回复流结束，finishMessage 把
  // currentMessage 归档进 messages[]。此时 form-answered 才到达
  // （用户提交→服务端回执的往返延迟），此时 currentMessage 已为 null，
  // 只有 messages[] 里能找到该 block。旧实现只查 currentMessage，
  // 会静默失败导致 FormCard 卡在 pending。
  it('updates form block after message archive (form-answered arrives post-finishMessage)', () => {
    const store = createConversationStore('session-1', createDeps())

    // 1. AI 一轮回复中发 form 事件 → block 挂到 currentMessage
    store.getState().handleAIEvent({
      type: 'form',
      sessionId: 'frontend-session-1',
      formId: 'form-5',
      title: '归档后回填',
      read: 'full',
      target: 'cap.todo',
      action: 'create',
      fields: [{ name: 'content', type: 'string' }],
    } satisfies AIEvent)

    const pendingInCurrent = store.getState().currentMessage?.blocks.find(
      (b) => b.type === 'form',
    )
    expect(pendingInCurrent?.status).toBe('pending')

    // 2. AI 回复完成 → finishMessage 归档到 messages[]
    store.getState().finishMessage()

    // 归档后 currentMessage 为空，form block 应在 messages[0] 里
    const currentAfterArchive = store.getState().currentMessage
    expect(currentAfterArchive).toBeNull()
    const msgs = store.getState().messages
    expect(msgs).toHaveLength(1)
    const archivedForm = msgs[0].type === 'assistant'
      ? msgs[0].blocks.find((b) => b.type === 'form')
      : undefined
    expect(archivedForm?.status).toBe('pending')

    // 3. 用户提交 → 服务端回执 → form-answered 事件到达（跨 messages[] 查找）
    store.getState().handleAIEvent({
      type: 'form-answered',
      sessionId: 'frontend-session-1',
      formId: 'form-5',
      ok: true,
      receipt: 'cap.todo.create ok: id=123',
    } satisfies AIEvent)

    // 断言：messages[] 里的 form block 已被更新为 submitted
    const msgAfter = store.getState().messages
    expect(msgAfter).toHaveLength(1)
    expect(msgAfter[0].type).toBe('assistant')
    const updatedForm = msgAfter[0].type === 'assistant'
      ? msgAfter[0].blocks.find((b) => b.type === 'form')
      : undefined
    expect(updatedForm).toMatchObject({
      type: 'form',
      id: 'form-5',
      status: 'submitted',
      ok: true,
      receipt: 'cap.todo.create ok: id=123',
    })
    // 幂等：不能因找不到 block 而抛错或产生额外消息
    expect(store.getState().currentMessage).toBeNull()
  })

  // 补充：form block 归档在 messages[] 中间时，仍能精确定位
  // （不是简单扫第一条就更新，避免误改别的 form block）
  it('locates the correct form block among multiple archived forms by formId', () => {
    const store = createConversationStore('session-1', createDeps())

    // 两条独立会话各自一个 form，模拟 messages 中多个 form block 共存
    store.getState().handleAIEvent({
      type: 'form',
      sessionId: 'frontend-session-1',
      formId: 'form-A',
      read: 'full',
      target: 'cap.todo',
      action: 'create',
      fields: [{ name: 'content', type: 'string' }],
    } satisfies AIEvent)
    store.getState().finishMessage()

    store.getState().handleAIEvent({
      type: 'form',
      sessionId: 'frontend-session-1',
      formId: 'form-B',
      read: 'full',
      target: 'cap.todo',
      action: 'create',
      fields: [{ name: 'content', type: 'string' }],
    } satisfies AIEvent)
    store.getState().finishMessage()

    // 只回填 form-B → form-A 必须保持 pending
    store.getState().handleAIEvent({
      type: 'form-answered',
      sessionId: 'frontend-session-1',
      formId: 'form-B',
      ok: true,
      receipt: 'only B submitted',
    } satisfies AIEvent)

    const msgs = store.getState().messages
    expect(msgs).toHaveLength(2)
    const msgA = msgs[0] as import('../../types/chat').AssistantChatMessage
    const msgB = msgs[1] as import('../../types/chat').AssistantChatMessage
    const formA = msgA.blocks.find((b) => b.type === 'form')
    const formB = msgB.blocks.find((b) => b.type === 'form')

    expect(formA).toMatchObject({ id: 'form-A', status: 'pending' })
    expect(formB).toMatchObject({
      id: 'form-B',
      status: 'submitted',
      ok: true,
      receipt: 'only B submitted',
    })
  })

  // 边界：form-answered 到达时 block 既不在 currentMessage 也已被归档出 messages[]
  // （如会话已切走 / 压缩移除后迟到回执）。更新必须静默安全——
  // 不抛错、不产生副作用、不误改其他 block。
  it('silently ignores form-answered when block is nowhere (no currentMessage, not in messages)', () => {
    const store = createConversationStore('session-1', createDeps())
    const before = store.getState()

    // 无 currentMessage、无 messages，直接迟到回执
    expect(before.currentMessage).toBeNull()
    expect(before.messages).toHaveLength(0)

    expect(() => {
      store.getState().handleAIEvent({
        type: 'form-answered',
        sessionId: 'frontend-session-1',
        formId: 'ghost-form',
        ok: true,
        receipt: 'late receipt for a removed block',
      } satisfies AIEvent)
    }).not.toThrow()

    const after = store.getState()
    expect(after.currentMessage).toBeNull()
    expect(after.messages).toHaveLength(0)
  })

  // 边界：formBlockMap 快路径索引在归档后若指向新 currentMessage 中的错位 form，
  // 必须按 formId 校验拒绝，不得误更新到另一个 form（旧 idx 指向非本 form 的块）。
  it('formBlockMap stale idx must not mis-update a different form in new currentMessage', () => {
    const store = createConversationStore('session-1', createDeps())

    // 1. form-A 挂到 currentMessage[idx=0]，随后归档到 messages
    store.getState().handleAIEvent({
      type: 'form',
      sessionId: 'frontend-session-1',
      formId: 'form-A',
      read: 'full',
      target: 'cap.todo',
      action: 'create',
      fields: [{ name: 'content', type: 'string' }],
    } satisfies AIEvent)
    store.getState().finishMessage() // 归档 → currentMessage=null
    expect(store.getState().currentMessage).toBeNull()

    // 2. 新一轮：新 form-B 挂到新的 currentMessage[idx=0]（formBlockMap 仍残留 form-A→0）
    store.getState().handleAIEvent({
      type: 'form',
      sessionId: 'frontend-session-1',
      formId: 'form-B',
      read: 'full',
      target: 'cap.todo',
      action: 'create',
      fields: [{ name: 'content', type: 'string' }],
    } satisfies AIEvent)
    expect(store.getState().currentMessage?.blocks[0]).toMatchObject({ id: 'form-B' })

    // 3. 迟到 form-answered 回填 form-A：不得误更新正在 pending 的 form-B
    store.getState().handleAIEvent({
      type: 'form-answered',
      sessionId: 'frontend-session-1',
      formId: 'form-A',
      ok: true,
      receipt: 'A submitted',
    } satisfies AIEvent)

    // form-B 必须仍为 pending（未被错误标记成 submitted），form-A 应被正确归档
    const cur = store.getState().currentMessage
    const curFormB = cur?.blocks.find((b) => b.type === 'form')
    expect(curFormB).toMatchObject({ id: 'form-B', status: 'pending' })
    const msgA = store.getState().messages.find((m) => m.type === 'assistant') as
      | import('../../types/chat').AssistantChatMessage
      | undefined
    const formA = msgA?.blocks.find((b) => b.type === 'form')
    expect(formA).toMatchObject({ id: 'form-A', status: 'submitted', ok: true })
  })
})
