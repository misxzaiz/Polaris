/**
 * ErrorBanner 组件测试
 *
 * 覆盖（案 U3：错误横幅重试静默丢附件修复）：
 * 1. 带附件的最后一条用户消息 → 点重试 → sendMessage 收到映射后的 attachments 参数
 * 2. 无附件的最后一条用户消息 → sendMessage 第三参为 undefined（回归护栏）
 * 3. 存储态附件含形状异常条目 → 异常条目跳过、合法条目保留，重试路径不崩
 * 4. 消息中无用户消息 → 不渲染重试按钮（无重试目标）
 *
 * react-i18next 已在 src/test/setup.ts 全局 mock（t 返回 key）；
 * 这里 mock ErrorBanner 直接消费的两个 hook 边界（useActiveSession / useWorkspaceStore）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ChatMessage, UserChatMessage } from '@/types/chat'

// vi.hoisted 容器：vi.mock 工厂与测试体共享可变状态
const harness = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  sendMessage: vi.fn(),
  clearError: vi.fn(),
  workspace: {
    workspaces: [{ id: 'w1', name: '工作区', path: '/workspace/path' }],
    currentWorkspaceId: 'w1',
  },
}))

vi.mock('@/stores', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) => selector(harness.workspace),
}))

vi.mock('@/stores/conversationStore/useActiveSession', () => ({
  useActiveSessionActions: () => ({
    sendMessage: harness.sendMessage,
    clearError: harness.clearError,
  }),
  useActiveSessionMessages: () => ({
    messages: harness.messages,
    archivedMessages: [],
    currentMessage: null,
  }),
}))

import { ErrorBanner } from './ErrorBanner'

function makeUserMessage(
  content: string,
  attachments?: UserChatMessage['attachments']
): UserChatMessage {
  return { id: `u-${content}`, type: 'user', content, timestamp: '2026-01-01T00:00:00Z', attachments }
}

describe('ErrorBanner 重试回传附件（案 U3）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    harness.messages = []
  })

  it('带附件的最后一条用户消息 → 重试时 sendMessage 收到映射后的 attachments', () => {
    // 三条消息：只有最后一条用户消息（带图）是重试目标
    harness.messages = [
      makeUserMessage('第一条'),
      { id: 'a1', type: 'assistant', timestamp: '2026-01-01T00:00:01Z', blocks: [] },
      makeUserMessage('看这张图', [
        { id: 'att-1', type: 'image', fileName: 'shot.png', fileSize: 2048, mimeType: 'image/png' },
      ]),
    ] as ChatMessage[]

    render(<ErrorBanner error="errors:appError.network" />)
    fireEvent.click(screen.getByTitle('retry'))

    expect(harness.clearError).toHaveBeenCalledTimes(1)
    expect(harness.sendMessage).toHaveBeenCalledTimes(1)
    const [content, workspaceDir, attachments] = harness.sendMessage.mock.calls[0]
    expect(content).toBe('看这张图')
    expect(workspaceDir).toBe('/workspace/path')
    // 存储态五元组无损映射；source/status 为类型必填的中性补齐值，content 缺失不伪造
    expect(attachments).toEqual([
      {
        id: 'att-1',
        type: 'image',
        fileName: 'shot.png',
        fileSize: 2048,
        mimeType: 'image/png',
        source: 'select',
        content: '',
        status: 'ready',
      },
    ])
  })

  it('无附件的最后一条用户消息 → sendMessage 第三参为 undefined（不引入空数组回归）', () => {
    harness.messages = [makeUserMessage('纯文本')] as ChatMessage[]

    render(<ErrorBanner error="some error" />)
    fireEvent.click(screen.getByTitle('retry'))

    expect(harness.sendMessage).toHaveBeenCalledTimes(1)
    const [content, , attachments] = harness.sendMessage.mock.calls[0]
    expect(content).toBe('纯文本')
    expect(attachments).toBeUndefined()
  })

  it('存储态附件含形状异常条目 → 异常条目跳过、合法条目保留，重试不崩', () => {
    // 运行时异构数据（历史/外部写入）可能不满足 UserChatMessage.attachments 类型，
    // 刻意构造越界条目验证守卫：null / 未知 type / 缺 id 均跳过，不硬转不崩溃
    const malformed = [
      null,
      { id: 'att-2', type: 'file', fileName: 'a.txt', fileSize: 10, mimeType: 'text/plain' },
      { id: 'att-3', type: 'link', fileName: 'x.html', fileSize: 1, mimeType: 'text/html' },
      { type: 'image', fileName: 'no-id.png', fileSize: 1, mimeType: 'image/png' },
    ] as unknown as UserChatMessage['attachments']

    harness.messages = [makeUserMessage('混合附件', malformed)] as ChatMessage[]

    render(<ErrorBanner error="some error" />)
    expect(() => fireEvent.click(screen.getByTitle('retry'))).not.toThrow()

    const attachments = harness.sendMessage.mock.calls[0][2]
    expect(attachments).toEqual([
      {
        id: 'att-2',
        type: 'file',
        fileName: 'a.txt',
        fileSize: 10,
        mimeType: 'text/plain',
        source: 'select',
        content: '',
        status: 'ready',
      },
    ])
  })

  it('消息中无用户消息 → 不渲染重试按钮', () => {
    harness.messages = [
      { id: 'a1', type: 'assistant', timestamp: '2026-01-01T00:00:01Z', blocks: [] },
    ] as ChatMessage[]

    render(<ErrorBanner error="some error" />)

    expect(screen.queryByTitle('retry')).toBeNull()
  })
})
