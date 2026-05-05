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

describe('conversation tool call pairing', () => {
  it('updates the matching tool block by callId when same-name tools overlap', () => {
    const store = createConversationStore('session-1', createDeps())

    store.getState().handleAIEvent({
      type: 'tool_call_start',
      sessionId: 'backend-session',
      callId: 'item_1',
      tool: 'shell',
      args: { command: 'git status' },
    } satisfies AIEvent)

    store.getState().handleAIEvent({
      type: 'tool_call_start',
      sessionId: 'backend-session',
      callId: 'item_2',
      tool: 'shell',
      args: { command: 'git log --oneline -5' },
    } satisfies AIEvent)

    store.getState().handleAIEvent({
      type: 'tool_call_end',
      sessionId: 'backend-session',
      callId: 'item_2',
      tool: 'shell',
      success: true,
      result: { output: 'log', exit_code: 0 },
    } satisfies AIEvent)

    const blocksAfterSecondEnd = store.getState().currentMessage?.blocks
    expect(blocksAfterSecondEnd?.[0]).toMatchObject({
      type: 'tool_call',
      id: 'item_1',
      status: 'running',
    })
    expect(blocksAfterSecondEnd?.[1]).toMatchObject({
      type: 'tool_call',
      id: 'item_2',
      status: 'completed',
    })

    store.getState().handleAIEvent({
      type: 'tool_call_end',
      sessionId: 'backend-session',
      callId: 'item_1',
      tool: 'shell',
      success: true,
      result: { output: 'status', exit_code: 0 },
    } satisfies AIEvent)

    const finalBlocks = store.getState().currentMessage?.blocks
    expect(finalBlocks?.[0]).toMatchObject({
      type: 'tool_call',
      id: 'item_1',
      status: 'completed',
    })
    expect(finalBlocks?.[1]).toMatchObject({
      type: 'tool_call',
      id: 'item_2',
      status: 'completed',
    })
  })
})
