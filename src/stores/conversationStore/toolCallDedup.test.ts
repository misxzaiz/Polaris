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

/**
 * 流式 + 快照双路径去重回归：
 * 后端在本 turn 已流式发出 tool_call_start / agent_run_start 后，
 * turn 结束的完整快照可能对同一 callId/taskId 重发一次，
 * 前端必须幂等（不追加重复块），否则消息流出现双工具卡、灵动岛出现双 agent 卡。
 */
describe('conversation duplicate event dedup', () => {
  it('does not append a duplicate tool_call block for the same callId', () => {
    const store = createConversationStore('session-1', createDeps())

    const start = {
      type: 'tool_call_start',
      sessionId: 'backend-session',
      callId: 'item_1',
      tool: 'bash',
      args: { command: 'git status' },
    } satisfies AIEvent

    store.getState().handleAIEvent(start)
    // 快照路径重发同一 callId
    store.getState().handleAIEvent({ ...start })

    const blocks = store.getState().currentMessage?.blocks
    expect(blocks?.filter((b) => b.type === 'tool_call' && b.id === 'item_1')).toHaveLength(1)
  })

  it('backfills missing input when a duplicate tool_call_start arrives', () => {
    const store = createConversationStore('session-1', createDeps())

    // 流式先到：args 缺失（部分引擎流式期 input 不完整）
    store.getState().handleAIEvent({
      type: 'tool_call_start',
      sessionId: 'backend-session',
      callId: 'item_1',
      tool: 'bash',
      args: {},
    } satisfies AIEvent)
    // 快照重发：携带完整 args
    store.getState().handleAIEvent({
      type: 'tool_call_start',
      sessionId: 'backend-session',
      callId: 'item_1',
      tool: 'bash',
      args: { command: 'git status' },
    } satisfies AIEvent)

    const blocks = store.getState().currentMessage?.blocks
    const toolBlocks = blocks?.filter((b) => b.type === 'tool_call')
    expect(toolBlocks).toHaveLength(1)
    expect(toolBlocks?.[0]).toMatchObject({ id: 'item_1', input: { command: 'git status' } })
  })

  it('does not append a duplicate agent_run block for the same taskId', () => {
    const store = createConversationStore('session-1', createDeps())

    const start = {
      type: 'agent_run_start',
      sessionId: 'backend-session',
      taskId: 'task_1',
      agentType: 'general-purpose',
    } satisfies AIEvent

    store.getState().handleAIEvent(start)
    store.getState().handleAIEvent({ ...start })

    const blocks = store.getState().currentMessage?.blocks
    expect(blocks?.filter((b) => b.type === 'agent_run' && b.id === 'task_1')).toHaveLength(1)
  })

  it('allows distinct tool callIds and agent taskIds to coexist', () => {
    const store = createConversationStore('session-1', createDeps())

    store.getState().handleAIEvent({
      type: 'tool_call_start',
      sessionId: 'backend-session',
      callId: 'a',
      tool: 'bash',
      args: {},
    } satisfies AIEvent)
    store.getState().handleAIEvent({
      type: 'tool_call_start',
      sessionId: 'backend-session',
      callId: 'b',
      tool: 'read',
      args: {},
    } satisfies AIEvent)
    store.getState().handleAIEvent({
      type: 'agent_run_start',
      sessionId: 'backend-session',
      taskId: 't1',
      agentType: 'general-purpose',
    } satisfies AIEvent)
    store.getState().handleAIEvent({
      type: 'agent_run_start',
      sessionId: 'backend-session',
      taskId: 't2',
      agentType: 'Explore',
    } satisfies AIEvent)

    const blocks = store.getState().currentMessage?.blocks
    expect(blocks?.filter((b) => b.type === 'tool_call')).toHaveLength(2)
    expect(blocks?.filter((b) => b.type === 'agent_run')).toHaveLength(2)
  })
})

/**
 * progressMessage 终态文案不应残留为"转圈的已完成卡"：
 * 后端工具结束发 ✅ progress，前端应清掉对应的 🔧 progressMessage，
 * 否则工具完成后岛仍显示一张 island-spin 的 "✅ Glob" 卡。
 */
describe('progress terminal cleanup', () => {
  it('clears progressMessage when a terminal ✅ progress arrives for the same tool', () => {
    const store = createConversationStore('session-1', createDeps())

    store.getState().handleAIEvent({
      type: 'progress',
      sessionId: 's',
      message: '🔧 Glob',
    } satisfies AIEvent)
    expect(store.getState().progressMessage).toBe('🔧 Glob')

    store.getState().handleAIEvent({
      type: 'progress',
      sessionId: 's',
      message: '✅ Glob',
    } satisfies AIEvent)
    expect(store.getState().progressMessage).toBeNull()
  })

  it('keeps unrelated progressMessage untouched on terminal progress', () => {
    const store = createConversationStore('session-1', createDeps())

    store.getState().handleAIEvent({ type: 'progress', sessionId: 's', message: '🔧 Glob' } satisfies AIEvent)
    store.getState().handleAIEvent({ type: 'progress', sessionId: 's', message: '✅ Bash' } satisfies AIEvent)
    // 不同工具的终态：保留 Glob 进行中文案（Bash 的终态不应误清 Glob）
    expect(store.getState().progressMessage).toBe('🔧 Glob')
  })
})
