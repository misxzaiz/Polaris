import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PushDialog } from './PushDialog'
import { useGitStore } from '@/stores/gitStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { GitRemote, GitBranch } from '@/types/git'
import type { GitState } from '@/stores/gitStore'

const remotes: GitRemote[] = [
  {
    name: 'origin',
    fetchUrl: 'https://github.com/polaris/polaris.git',
    pushUrl: 'https://github.com/polaris/polaris.git',
  },
]

const branches: GitBranch[] = [
  {
    name: 'main',
    isCurrent: true,
    isRemote: false,
    commit: '1111111111111111111111111111111111111111',
  },
  {
    name: 'feature/history',
    isCurrent: false,
    isRemote: false,
    commit: '2222222222222222222222222222222222222222',
  },
]

describe('PushDialog (P1 force-with-lease)', () => {
  const push = vi.fn()
  const pushWithLease = vi.fn()
  const getRemotes = vi.fn()
  const getBranches = vi.fn()
  const refreshStatus = vi.fn()
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()

    push.mockResolvedValue({
      success: true,
      pushedCommits: 1,
      rejected: false,
      needsUpstream: false,
    })
    pushWithLease.mockResolvedValue({
      success: true,
      pushedCommits: 1,
      rejected: false,
      needsUpstream: false,
    })
    getRemotes.mockResolvedValue(undefined)
    getBranches.mockResolvedValue(undefined)
    refreshStatus.mockResolvedValue(undefined)

    useGitStore.setState({
      push: push as unknown as GitState['push'],
      pushWithLease: pushWithLease as unknown as GitState['pushWithLease'],
      getRemotes: getRemotes as unknown as GitState['getRemotes'],
      getBranches: getBranches as unknown as GitState['getBranches'],
      refreshStatus: refreshStatus as unknown as GitState['refreshStatus'],
      remotes,
      branches,
      statuses: {
        'D:/repo': {
          branch: 'main',
          staged: [],
          unstaged: [],
          untracked: [],
          ahead: 1,
          behind: 0,
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
  })

  it('calls pushWithLease when force is enabled', async () => {
    render(
      <PushDialog
        isOpen
        onClose={onClose}
        workspacePath="D:/repo"
        defaultRemote="origin"
        defaultBranch="main"
      />
    )

    // 等待默认值初始化完成
    await waitFor(() => {
      expect(screen.getByText('push.dialogTitle')).toBeInTheDocument()
    })

    // 勾选 force-with-lease
    fireEvent.click(screen.getByText('push.forcePush'))

    // 点推送按钮
    fireEvent.click(screen.getByText('push.push'))

    await waitFor(() => {
      expect(pushWithLease).toHaveBeenCalledWith('D:/repo', 'main', 'origin', undefined)
    })
    expect(push).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('calls push without force when force is unchecked', async () => {
    render(
      <PushDialog
        isOpen
        onClose={onClose}
        workspacePath="D:/repo"
        defaultRemote="origin"
        defaultBranch="main"
      />
    )

    await waitFor(() => {
      expect(screen.getByText('push.dialogTitle')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('push.push'))

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('D:/repo', 'main', 'origin', false, false, undefined)
    })
    expect(pushWithLease).not.toHaveBeenCalled()
  })
})