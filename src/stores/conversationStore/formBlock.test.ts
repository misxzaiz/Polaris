import { describe, expect, it } from 'vitest'
import { createConversationStore } from './createConversationStore'
import type { AIEvent } from '../../ai-runtime'
import type { StoreDeps } from './types'

function createDeps(): StoreDeps {
  return {
    getConfig: () => ({ defaultEngine: 'codex' }),
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
})
