import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReflogView } from './ReflogView'
import { useGitStore } from '@/stores/gitStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { GitReflogEntry } from '@/types/git'
import type { GitState } from '@/stores/gitStore'

const reflogEntries: GitReflogEntry[] = [
  {
    selector: 'HEAD@{0}',
    subject: 'commit: Add reflog panel',
    sha: '3333333333333333333333333333333333333333',
    shortSha: '3333333',
    timestamp: 1_700_000_200,
    branch: 'main',
  },
  {
    selector: 'HEAD@{1}',
    subject: 'commit: Fix search panel',
    sha: '1111111111111111111111111111111111111111',
    shortSha: '1111111',
    timestamp: 1_700_000_000,
    branch: null,
  },
]

describe('ReflogView (P1 差异点 #1)', () => {
  const getReflog = vi.fn()
  const checkoutCommit = vi.fn()
  const refreshStatus = vi.fn()
  const onBack = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()

    getReflog.mockResolvedValue(reflogEntries)
    checkoutCommit.mockResolvedValue(undefined)
    refreshStatus.mockResolvedValue(undefined)

    useGitStore.setState({
      getReflog: getReflog as unknown as GitState['getReflog'],
      checkoutCommit: checkoutCommit as unknown as GitState['checkoutCommit'],
      refreshStatus: refreshStatus as unknown as GitState['refreshStatus'],
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

  it('loads and renders reflog entries with selector and branch badge', async () => {
    render(<ReflogView workspacePath="D:/repo" onBack={onBack} />)

    expect(getReflog).toHaveBeenCalledWith('D:/repo', null, 100)
    expect(await screen.findByText('HEAD@{0}')).toBeInTheDocument()
    expect(await screen.findByText(/Add reflog panel/)).toBeInTheDocument()
    // branch 徽标只对 branch 非空的条目显示
    expect(screen.getAllByText('main').length).toBe(1)
  })

  it('restores a commit after two-step confirm', async () => {
    render(<ReflogView workspacePath="D:/repo" onBack={onBack} />)

    await screen.findByText('HEAD@{0}')

    // 第一步：点恢复按钮进入确认态
    fireEvent.click(screen.getAllByTitle(/history.reflogRestoreTitle/)[0])
    expect(screen.getByText('history.reflogRestoreConfirm')).toBeInTheDocument()

    // 第二步：确认执行
    fireEvent.click(screen.getByText('history.reflogRestore'))

    await waitFor(() => {
      expect(checkoutCommit).toHaveBeenCalledWith('D:/repo', '3333333333333333333333333333333333333333')
    })
    expect(refreshStatus).toHaveBeenCalledWith('D:/repo')
  })

  it('goes back to commit history via the back button', async () => {
    render(<ReflogView workspacePath="D:/repo" onBack={onBack} />)

    await screen.findByText('HEAD@{0}')

    fireEvent.click(screen.getByTitle('history.backToCommitHistory'))

    expect(onBack).toHaveBeenCalled()
  })
})