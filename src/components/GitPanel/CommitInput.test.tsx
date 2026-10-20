import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CommitInput } from './CommitInput'
import { useGitStore } from '@/stores/gitStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useConfigStore, useViewStore } from '@/stores'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'
import { useToastStore } from '@/stores/toastStore'
import type { GitState } from '@/stores/gitStore'

const invokeMock = vi.fn()
vi.mock('@/services/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  currentMode: 'tauri',
}))

const openCommitMessageChatMock = vi.fn()
vi.mock('@/services/commitMessageChat', () => ({
  openCommitMessageChat: (...args: unknown[]) => openCommitMessageChatMock(...args),
  useCommitMessageSuggestion: () => ({
    text: null,
    sessionId: null,
    isStreaming: false,
  }),
}))

describe('CommitInput (P1 amend)', () => {
  const commitChanges = vi.fn()
  const amendCommit = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    invokeMock.mockResolvedValue([])

    commitChanges.mockResolvedValue(undefined)
    amendCommit.mockResolvedValue(undefined)

    useGitStore.setState({
      commitChanges: commitChanges as unknown as GitState['commitChanges'],
      amendCommit: amendCommit as unknown as GitState['amendCommit'],
      getIndexFileDiff: (async () => ({})) as unknown as GitState['getIndexFileDiff'],
      getWorktreeFileDiff: (async () => ({})) as unknown as GitState['getWorktreeFileDiff'],
      statuses: {
        'D:/repo': {
          branch: 'main',
          staged: [{ path: 'src/App.tsx' }],
          unstaged: [],
          untracked: [],
        } as unknown as GitState['statuses'][string],
      },
    })

    useWorkspaceStore.setState({
      workspaces: [{
        id: 'workspace-1',
        name: 'Repo',
        path: 'D:/repo',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastAccessed: '2026-01-01T00:00:00.000Z',
      }],
      currentWorkspaceId: 'workspace-1',
      viewingWorkspaceId: null,
    })

    useConfigStore.setState({
      config: {
        defaultEngine: 'claude-code',
      } as never,
    })
    useViewStore.setState({
      rightPanelCollapsed: true,
    } as never)
    useEngineMetadataStore.setState({
      metadatas: [],
    } as never)
    useToastStore.setState({
      toasts: [],
    } as never)
  })

  it('allows amending with an empty message (no-edit semantics)', async () => {
    render(<CommitInput />)

    // 有暂存文件，但消息为空
    // 打开 amend 开关（label 带 title，用 title 定位独立于按钮文案）
    fireEvent.click(screen.getByTitle('commit.amendDesc'))

    // amend 开关下空消息提示出现，提交按钮可点（不禁用）
    expect(screen.getByText('commit.amendEmptyMessage')).toBeInTheDocument()

    // 点提交按钮（按钮在 amend 模式下文案也是 commit.amend，用 role 精确定位 button）
    fireEvent.click(screen.getByRole('button', { name: 'commit.amend' }))

    await waitFor(() => {
      expect(amendCommit).toHaveBeenCalledWith('D:/repo', undefined, true, undefined)
    })
    expect(commitChanges).not.toHaveBeenCalled()
  })

  it('requires a message for a normal commit even with staged files', async () => {
    render(<CommitInput />)

    // 未开 amend，空消息时提交按钮应为禁用
    expect(screen.getByText('commit.button').closest('button')).toBeDisabled()

    // 输入消息后可用
    fireEvent.change(screen.getByPlaceholderText('commit.placeholder'), {
      target: { value: 'feat: add amend support' },
    })

    await waitFor(() => {
      expect(screen.getByText('commit.button').closest('button')).toBeEnabled()
    })
  })
})