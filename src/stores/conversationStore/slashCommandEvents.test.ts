import { describe, expect, it } from 'vitest'
import { createConversationStore } from './createConversationStore'
import { useCliInfoStore } from '../cliInfoStore'
import type { AIEvent } from '../../ai-runtime'
import type { StoreDeps } from './types'

function createDeps(): StoreDeps {
  return {
    getConfig: () => ({ defaultEngine: 'claude-code' }),
    getWorkspace: () => null,
    getContextWorkspaceIds: () => [],
    getAllWorkspaces: () => [],
    getEventRouter: () => ({}) as StoreDeps['getEventRouter'] extends () => infer T ? T : never,
    contextId: 'test-context',
  }
}

describe('Claude CLI 斜杠命令事件链路', () => {
  it('context_compacted 事件插入压缩分隔块并随 session_end 落入消息列表', () => {
    const store = createConversationStore('session-compact', createDeps())

    store.getState().handleAIEvent({
      type: 'session_start',
      sessionId: 'backend-session',
    } as AIEvent)

    store.getState().handleAIEvent({
      type: 'context_compacted',
      sessionId: 'backend-session',
      trigger: 'manual',
      preTokens: 29678,
      postTokens: 1000,
    } satisfies AIEvent)

    const block = store.getState().currentMessage?.blocks[0]
    expect(block).toMatchObject({
      type: 'context_compact',
      trigger: 'manual',
      preTokens: 29678,
      postTokens: 1000,
    })

    store.getState().handleAIEvent({
      type: 'session_end',
      sessionId: 'backend-session',
    } as AIEvent)

    // finishMessage 后块进入消息列表，流式态清空
    const messages = store.getState().messages
    const lastMessage = messages[messages.length - 1]
    expect(lastMessage?.type).toBe('assistant')
    expect((lastMessage as { blocks: Array<{ type: string }> }).blocks[0]?.type).toBe('context_compact')
    expect(store.getState().currentMessage).toBeNull()
    expect(store.getState().progressMessage).toBeNull()
  })

  it('cli_init 事件把 slashCommands 同步到 cliInfoStore', () => {
    const store = createConversationStore('session-init', createDeps())

    store.getState().handleAIEvent({
      type: 'cli_init',
      sessionId: 'backend-session',
      tools: ['Bash', 'Read'],
      slashCommands: ['compact', 'context', 'mcp', 'my-custom-cmd'],
      model: 'qusc',
      claudeCodeVersion: '2.1.205',
    } satisfies AIEvent)

    const cliInfo = useCliInfoStore.getState()
    expect(cliInfo.slashCommands).toEqual(['compact', 'context', 'mcp', 'my-custom-cmd'])
    expect(cliInfo.currentModel).toBe('qusc')
    expect(cliInfo.version).toBe('2.1.205')
  })
})
