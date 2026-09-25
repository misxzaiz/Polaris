import { beforeEach, describe, expect, it, vi } from 'vitest'
import { historyService } from './historyService'
import type { ChatMessage } from '../types'

// ── Mock 依赖 ────────────────────────────────────────────────

const claudeGetSessionHistoryMock = vi.hoisted(() => vi.fn())
const claudeConvertMock = vi.hoisted(() => vi.fn())
const createSessionFromHistoryMock = vi.hoisted(() => vi.fn())
const addToMultiViewMock = vi.hoisted(() => vi.fn())

vi.mock('./claudeCodeHistoryService', () => ({
  getClaudeCodeHistoryService: () => ({
    getSessionHistory: claudeGetSessionHistoryMock,
    convertToChatMessages: claudeConvertMock,
  }),
}))

vi.mock('./dialogStorage', () => ({
  dialogStorageService: {
    getConversationPage: vi.fn().mockResolvedValue(null),
    listConversations: vi.fn().mockResolvedValue([]),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({
      workspaces: [],
      createWorkspace: vi.fn(),
    }),
  },
}))

vi.mock('../stores/index', () => ({
  useViewStore: {
    getState: () => ({
      addToMultiView: addToMultiViewMock,
    }),
  },
}))

vi.mock('../stores/conversationStore/sessionStoreManager', () => ({
  sessionStoreManager: {
    getState: () => ({
      createSessionFromHistory: createSessionFromHistoryMock,
    }),
  },
}))

vi.mock('../stores/configStore', () => ({
  useConfigStore: {
    getState: () => ({
      config: { defaultEngine: 'claude-code' },
    }),
  },
}))

// ── Tests ────────────────────────────────────────────────────

describe('historyService.restoreFromHistory', () => {
  beforeEach(() => {
    localStorage.clear()
    claudeGetSessionHistoryMock.mockReset()
    claudeConvertMock.mockReset()
    createSessionFromHistoryMock.mockReset()
    addToMultiViewMock.mockReset()
    createSessionFromHistoryMock.mockReturnValue('new-session-id')
  })

  it('调用 Claude Code 历史服务并把消息塞进 createSessionFromHistory', async () => {
    const claudeRaw = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，需要帮忙吗？' },
    ]
    const converted: ChatMessage[] = [
      { id: 'm1', type: 'user', content: '你好', timestamp: '2026-05-01T00:00:00Z' },
      {
        id: 'm2',
        type: 'assistant',
        blocks: [{ type: 'text', content: '你好，需要帮忙吗？' }],
        timestamp: '2026-05-01T00:00:01Z',
        isStreaming: false,
        engineId: 'claude-code',
      },
    ]
    claudeGetSessionHistoryMock.mockResolvedValueOnce(claudeRaw)
    claudeConvertMock.mockReturnValueOnce(converted)

    const ok = await historyService.restoreFromHistory('claude-sid-1', 'claude-code')

    expect(ok).toBe(true)
    expect(claudeGetSessionHistoryMock).toHaveBeenCalledWith(
      'claude-sid-1',
      undefined, // claudeProjectName 未传
    )
    expect(claudeConvertMock).toHaveBeenCalledWith(claudeRaw)
    // createSessionFromHistory 的第一个参数应是转换后的消息数组（且 assistant 已含 engineId）
    const [messagesArg, externalIdArg, metaArg] =
      createSessionFromHistoryMock.mock.calls[0]
    expect(messagesArg).toHaveLength(2)
    expect(messagesArg[0]).toMatchObject({ type: 'user', content: '你好' })
    expect(messagesArg[1]).toMatchObject({ type: 'assistant', engineId: 'claude-code' })
    expect(externalIdArg).toBe('claude-sid-1')
    expect(metaArg).toMatchObject({ engineId: 'claude-code' })
  })
})
