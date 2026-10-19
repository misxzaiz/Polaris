import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteTab } from './RemoteTab'
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
]

describe('RemoteTab (P1 fetch / auto-fetch)', () => {
  const getRemotes = vi.fn()
  const fetchRemote = vi.fn()
  const getBranches = vi.fn()
  const refreshStatus = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()

    getRemotes.mockImplementation(async () => {
      useGitStore.setState({ remotes })
    })
    fetchRemote.mockResolvedValue(undefined)
    getBranches.mockResolvedValue(undefined)
    refreshStatus.mockResolvedValue(undefined)

    useGitStore.setState({
      getRemotes: getRemotes as unknown as GitState['getRemotes'],
      fetchRemote: fetchRemote as unknown as GitState['fetchRemote'],
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

  it('renders remote list and fetches on the fetch button', async () => {
    render(<RemoteTab />)

    // 等待远程列表渲染
    expect(await screen.findByText('origin')).toBeInTheDocument()

    // 点击远程项内的 fetch 按钮
    fireEvent.click(screen.getByTitle('remote.fetchFrom'))

    await waitFor(() => {
      expect(fetchRemote).toHaveBeenCalledWith('D:/repo', 'origin', false)
    })
  })

  it('persists auto-fetch toggle to localStorage and restores it', async () => {
    const { unmount } = render(<RemoteTab />)
    await screen.findByText('origin')

    // 默认关
    expect(window.localStorage.getItem('polaris.git.autoFetch')).toBeNull()

    // 打开 auto-fetch
    fireEvent.click(screen.getByLabelText('remote.autoFetch'))

    await waitFor(() => {
      expect(window.localStorage.getItem('polaris.git.autoFetch')).toBe('1')
    })

    unmount()

    // 重新挂载应从 localStorage 恢复开启状态
    render(<RemoteTab />)
    await screen.findByText('origin')

    expect(window.localStorage.getItem('polaris.git.autoFetch')).toBe('1')
    expect(screen.getByLabelText('remote.autoFetch')).toBeInTheDocument()
  })
})