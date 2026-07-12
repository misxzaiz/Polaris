import { beforeEach, describe, expect, it, vi } from 'vitest'
import { historyService } from './historyService'
import type { ChatMessage } from '../types'

// ── Mock 依赖 ────────────────────────────────────────────────

const codexGetSessionHistoryMock = vi.hoisted(() => vi.fn())
const codexConvertMock = vi.hoisted(() => vi.fn())
const claudeGetSessionHistoryMock = vi.hoisted(() => vi.fn())
const claudeConvertMock = vi.hoisted(() => vi.fn())
const createSessionFromHistoryMock = vi.hoisted(() => vi.fn())
const addToMultiViewMock = vi.hoisted(() => vi.fn())

vi.mock('./codexHistoryService', () => ({
  getCodexHistoryService: () => ({
    getSessionHistory: codexGetSessionHistoryMock,
    convertToChatMessages: codexConvertMock,
  }),
}))

vi.mock('./claudeCodeHistoryService', () => ({
  getClaudeCodeHistoryService: () => ({
    getSessionHistory: claudeGetSessionHistoryMock,
    convertToChatMessages: claudeConvertMock,
  }),
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
      multiSessionMode: false,
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

describe('historyService.restoreFromHistory — codex 分支', () => {
  beforeEach(() => {
    localStorage.clear()
    codexGetSessionHistoryMock.mockReset()
    codexConvertMock.mockReset()
    claudeGetSessionHistoryMock.mockReset()
    claudeConvertMock.mockReset()
    createSessionFromHistoryMock.mockReset()
    addToMultiViewMock.mockReset()
    createSessionFromHistoryMock.mockReturnValue('new-session-id')
  })

  it('调用 Codex 历史服务并把消息塞进 createSessionFromHistory', async () => {
    const codexRaw = [
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
        engineId: 'codex',
      },
    ]
    codexGetSessionHistoryMock.mockResolvedValueOnce(codexRaw)
    codexConvertMock.mockReturnValueOnce(converted)

    const ok = await historyService.restoreFromHistory(
      'codex-sid-1',
      'codex',
      undefined,
      undefined,
      'Codex 对话',
    )

    expect(ok).toBe(true)
    expect(codexGetSessionHistoryMock).toHaveBeenCalledWith('codex-sid-1')
    expect(codexConvertMock).toHaveBeenCalledWith(codexRaw)
    // createSessionFromHistory 的第一个参数应是转换后的消息数组（且 assistant 已含 engineId）
    const [messagesArg, externalIdArg, metaArg] =
      createSessionFromHistoryMock.mock.calls[0]
    expect(messagesArg).toHaveLength(2)
    expect(messagesArg[0]).toMatchObject({ type: 'user', content: '你好' })
    expect(messagesArg[1]).toMatchObject({ type: 'assistant', engineId: 'codex' })
    expect(externalIdArg).toBe('codex-sid-1')
    expect(metaArg).toMatchObject({ title: 'Codex 对话', engineId: 'codex' })
    // claude-code 路径不应该被触发
    expect(claudeGetSessionHistoryMock).not.toHaveBeenCalled()
  })

  it('codex 后端返回空时仍允许创建会话（裸 resume 兜底）', async () => {
    codexGetSessionHistoryMock.mockResolvedValueOnce([])

    const ok = await historyService.restoreFromHistory('codex-sid-empty', 'codex')

    expect(ok).toBe(true)
    expect(codexGetSessionHistoryMock).toHaveBeenCalledWith('codex-sid-empty')
    // convertToChatMessages 不应被调用（空数组短路）
    expect(codexConvertMock).not.toHaveBeenCalled()
    const [messagesArg, externalIdArg, metaArg] =
      createSessionFromHistoryMock.mock.calls[0]
    expect(messagesArg).toEqual([])
    expect(externalIdArg).toBe('codex-sid-empty')
    expect(metaArg).toMatchObject({ engineId: 'codex' })
  })
})
