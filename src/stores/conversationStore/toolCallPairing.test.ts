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

  it('skips tool_call block for ask_user_question and renders only the question block', () => {
    const store = createConversationStore('session-1', createDeps())

    store.getState().handleAIEvent({
      type: 'tool_call_start',
      sessionId: 'backend-session',
      callId: 'tool_ask_1',
      tool: 'mcp__polaris-ask__ask_user_question',
      args: {
        questions: [{
          question: 'Pick a mode',
          header: 'Mode',
          options: [{ label: 'Fast' }, { label: 'Careful' }],
        }],
      },
    } satisfies AIEvent)

    // ask 是交互型工具：不创建普通 tool_call block，仅由 question 事件渲染专用卡片
    let blocks = store.getState().currentMessage?.blocks
    expect(blocks).toBeUndefined()

    store.getState().handleAIEvent({
      type: 'question',
      sessionId: 'frontend-session-1',
      questionId: 'ask-call-1',
      header: 'Pick a mode',
      options: [
        { value: 'Fast', label: 'Fast' },
        { value: 'Careful', label: 'Careful' },
      ],
      questions: [{
        question: 'Pick a mode',
        header: 'Mode',
        options: [
          { value: 'Fast', label: 'Fast' },
          { value: 'Careful', label: 'Careful' },
        ],
      }],
    } satisfies AIEvent)

    blocks = store.getState().currentMessage?.blocks
    expect(blocks).toHaveLength(1)
    expect(blocks?.[0]).toMatchObject({
      type: 'question',
      id: 'ask-call-1',
      sessionId: 'frontend-session-1',
      status: 'pending',
    })
  })

  it('dedupes duplicate question events (dual-channel delivery) so only one panel renders', () => {
    const store = createConversationStore('session-1', createDeps())

    const questionEvent = {
      type: 'question',
      sessionId: 'frontend-session-1',
      questionId: 'ask-call-dup',
      header: 'Pick a mode',
      options: [
        { value: 'Fast', label: 'Fast' },
        { value: 'Careful', label: 'Careful' },
      ],
      questions: [{
        question: 'Pick a mode',
        header: 'Mode',
        options: [
          { value: 'Fast', label: 'Fast' },
          { value: 'Careful', label: 'Careful' },
        ],
      }],
    } satisfies AIEvent

    // 桌面模式：同一 question 事件经 Tauri 直发 + 广播中继双通道各到达一次
    store.getState().handleAIEvent(questionEvent)
    store.getState().handleAIEvent(questionEvent)

    const blocks = store.getState().currentMessage?.blocks
    expect(blocks).toHaveLength(1)
    expect(blocks?.[0]).toMatchObject({
      type: 'question',
      id: 'ask-call-dup',
      status: 'pending',
    })

    // 已答态也只作用于唯一 block，不产生第二个
    store.getState().handleAIEvent({
      type: 'question_answered',
      sessionId: 'frontend-session-1',
      questionId: 'ask-call-dup',
      answers: [{ selected: ['Fast'] }],
      declined: false,
    } satisfies AIEvent)

    expect(store.getState().currentMessage?.blocks).toHaveLength(1)
    expect(store.getState().currentMessage?.blocks?.[0]).toMatchObject({
      type: 'question',
      id: 'ask-call-dup',
      status: 'answered',
    })
  })

  it('updates the separate ask question block by questionId', () => {
    const store = createConversationStore('session-1', createDeps())

    // ask 交互工具不产生 tool_call block，question 块是 blocks[0]
    store.getState().handleAIEvent({
      type: 'question',
      sessionId: 'frontend-session-1',
      questionId: 'ask-call-1',
      header: 'Pick a mode',
      options: [
        { value: 'Fast', label: 'Fast' },
        { value: 'Careful', label: 'Careful' },
      ],
    } satisfies AIEvent)

    store.getState().handleAIEvent({
      type: 'question_answered',
      sessionId: 'frontend-session-1',
      questionId: 'ask-call-1',
      answers: [{ selected: ['Careful'] }],
      declined: false,
    } satisfies AIEvent)

    const block = store.getState().currentMessage?.blocks[0]
    expect(block).toMatchObject({
      type: 'question',
      id: 'ask-call-1',
      status: 'answered',
      answers: [{ selected: ['Careful'] }],
    })
  })
})
