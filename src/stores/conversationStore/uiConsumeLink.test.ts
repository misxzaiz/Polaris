/**
 * cap.ui 消费链路集成测试：真实 tool_call_start 事件 → eventHandler → consumeCapUiDispatch → configStore。
 *
 * 验证 eventHandler 的 tool_call_start 分支在 tool 为 bus_dispatch（SimpleAI 经 MCP 挂载的
 * 命名 `mcp__polaris-bus__bus_dispatch`）时，把 args 里的 cap.ui 动作映射到前端 store。
 *
 * 这里 mock 掉 configStore（隔离副作用），保持 consumeCapUiDispatch 真实，证明
 * 「引擎事件 → store 生效」链路在 eventHandler 层接通。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createConversationStore } from './createConversationStore'
import type { AIEvent } from '../../ai-runtime'
import type { StoreDeps } from './types'

// mock configStore：捕获 updateConfigPatch，验证 cap.ui.chat patch 落 store
const updateConfigPatchMock = vi.fn()
const configGetStateMock = vi.fn()
vi.mock('@/stores/configStore', () => ({
  useConfigStore: {
    getState: () => configGetStateMock(),
  },
}))

function createDeps(): StoreDeps {
  return {
    getConfig: () => ({ defaultEngine: 'simple-ai' }),
    getWorkspace: () => null,
    getContextWorkspaceIds: () => [],
    getAllWorkspaces: () => [],
    getEventRouter: () => ({}) as StoreDeps['getEventRouter'] extends () => infer T ? T : never,
    contextId: 'test-context',
  }
}

describe('cap.ui 经 bus_dispatch tool_call_start 消费', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // config.chatDisplay 当前值（cap.ui.chat patch 在此基础上合并）
    configGetStateMock.mockReturnValue({
      config: { chatDisplay: { fontSize: 14, messageSpacing: 'comfortable' } },
      updateConfigPatch: updateConfigPatchMock,
    })
  })

  it('bus_dispatch（mcp__polaris-bus 前缀）携带 cap.ui.chat patch → configStore patch 合并', () => {
    const store = createConversationStore('session-1', createDeps())
    store.getState().handleAIEvent({
      type: 'tool_call_start',
      sessionId: 'backend-session',
      callId: 'item_ui_1',
      tool: 'mcp__polaris-bus__bus_dispatch',
      args: {
        target: 'cap.ui.chat',
        payload: { action: 'patch', config: { fontSize: 20, messageSpacing: 'spacious' } },
      },
    } as AIEvent)

    // cap.ui.chat patch → updateConfigPatch({ chatDisplay: { ...current, fontSize:20, messageSpacing:'spacious' } })
    expect(updateConfigPatchMock).toHaveBeenCalledTimes(1)
    const patch = updateConfigPatchMock.mock.calls[0][0]
    expect(patch.chatDisplay.fontSize).toBe(20)
    expect(patch.chatDisplay.messageSpacing).toBe('spacious')
    // 旧字段保留（合并而非覆盖）
    expect(patch.chatDisplay.lineHeight).toBe(undefined)
  })

  it('bus_dispatch 携带 cap.ui.theme applyPreset → 走主题消费（不抛错、不落 configStore）', () => {
    const store = createConversationStore('session-1', createDeps())
    expect(() => {
      store.getState().handleAIEvent({
        type: 'tool_call_start',
        sessionId: 'backend-session',
        callId: 'item_ui_2',
        tool: 'mcp__polaris-bus__bus_dispatch',
        args: {
          target: 'cap.ui.theme',
          payload: { action: 'applyPreset', preset: 'dark' },
        },
      } as AIEvent)
    }).not.toThrow()
    // cap.ui.theme 不走 configStore
    expect(updateConfigPatchMock).not.toHaveBeenCalled()
  })

  it('非 cap.ui 的 bus_dispatch（cap.todo）不触发 configStore 副作用', () => {
    const store = createConversationStore('session-1', createDeps())
    store.getState().handleAIEvent({
      type: 'tool_call_start',
      sessionId: 'backend-session',
      callId: 'item_ui_3',
      tool: 'mcp__polaris-bus__bus_dispatch',
      args: { target: 'cap.todo', payload: { action: 'list' } },
    } as AIEvent)
    expect(updateConfigPatchMock).not.toHaveBeenCalled()
  })

  it('裸名 bus_dispatch（无 mcp__ 前缀）同样被识别（防引擎变体漂移）', () => {
    const store = createConversationStore('session-1', createDeps())
    store.getState().handleAIEvent({
      type: 'tool_call_start',
      sessionId: 'backend-session',
      callId: 'item_ui_4',
      tool: 'bus_dispatch',
      args: {
        target: 'cap.ui.chat',
        payload: { action: 'patch', config: { fontFamily: 'serif' } },
      },
    } as AIEvent)
    const patch = updateConfigPatchMock.mock.calls[0]?.[0]
    expect(patch?.chatDisplay?.fontFamily).toBe('serif')
  })
})