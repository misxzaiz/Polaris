import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StashTab } from './StashTab'
import { useGitStore } from '@/stores/gitStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { GitStashEntry } from '@/types/git'
import type { GitState } from '@/stores/gitStore'

const stashes: GitStashEntry[] = [
  {
    index: 0,
    message: 'WIP on main: fix search panel',
    branch: 'main',
    timestamp: 1_700_000_000,
  },
  {
    index: 1,
    message: 'WIP on feature/history: add commit bridge',
    branch: 'feature/history',
    timestamp: 1_700_000_100,
  },
]

describe('StashTab (P1 三动作)', () => {
  const getStashList = vi.fn()
  const stashApply = vi.fn()
  const stashShow = vi.fn()
  const stashPop = vi.fn()
  const refreshStatus = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()

    getStashList.mockResolvedValue(stashes)
    stashApply.mockResolvedValue(undefined)
    stashShow.mockResolvedValue('diff --git a/src/App.tsx b/src/App.tsx\n@@ -1,1 +1,2 @@')
    stashPop.mockResolvedValue(undefined)
    refreshStatus.mockResolvedValue(undefined)

    useGitStore.setState({
      getStashList: getStashList as unknown as GitState['getStashList'],
      stashApply: stashApply as unknown as GitState['stashApply'],
      stashShow: stashShow as unknown as GitState['stashShow'],
      stashPop: stashPop as unknown as GitState['stashPop'],
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

  it('renders stash list entries', async () => {
    render(<StashTab />)

    expect(await screen.findByText('WIP on main: fix search panel')).toBeInTheDocument()
    expect(screen.getByText('WIP on feature/history: add commit bridge')).toBeInTheDocument()
    expect(getStashList).toHaveBeenCalledWith('D:/repo')
  })

  it('shows patch content on Eye click and closes the dialog', async () => {
    render(<StashTab />)

    await screen.findByText('WIP on main: fix search panel')

    fireEvent.click(screen.getAllByTitle('stash.showTitle')[0])

    await waitFor(() => {
      expect(stashShow).toHaveBeenCalledWith('D:/repo', 0)
    })
    expect(await screen.findByText(/diff --git a\/src\/App.tsx/)).toBeInTheDocument()

    // 关闭 patch 对话框（关闭按钮 title 用 common.cancel）
    fireEvent.click(screen.getByTitle('cancel'))

    await waitFor(() => {
      expect(screen.queryByText(/diff --git a\/src\/App.tsx/)).not.toBeInTheDocument()
    })
  })

  it('applies (keeps in list) on Play click without popping it', async () => {
    render(<StashTab />)

    await screen.findByText('WIP on main: fix search panel')

    fireEvent.click(screen.getAllByTitle('stash.applyTitle')[0])

    await waitFor(() => {
      expect(stashApply).toHaveBeenCalledWith('D:/repo', 0)
    })
    expect(stashPop).not.toHaveBeenCalled()
    expect(refreshStatus).toHaveBeenCalledWith('D:/repo')
  })

  it('pops (applies and removes) on Check click', async () => {
    render(<StashTab />)

    await screen.findByText('WIP on main: fix search panel')

    fireEvent.click(screen.getAllByTitle('stash.popTitle')[0])

    await waitFor(() => {
      expect(stashPop).toHaveBeenCalledWith('D:/repo', 0)
    })
    expect(getStashList).toHaveBeenCalledWith('D:/repo')
  })
})