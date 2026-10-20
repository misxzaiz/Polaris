import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteTab } from './RemoteTab'
import { useGitStore } from '@/stores/gitStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { GitRemote, GitBranch, GitConflictPrediction } from '@/types/git'
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
  const predictConflicts = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()

    getRemotes.mockImplementation(async () => {
      useGitStore.setState({ remotes })
    })
    fetchRemote.mockResolvedValue(undefined)
    getBranches.mockResolvedValue(undefined)
    refreshStatus.mockResolvedValue(undefined)
    predictConflicts.mockImplementation(async (_wsPath: string) => {
      const prediction: GitConflictPrediction = {
        branch: 'main',
        upstream: 'origin/main',
        behind: 1,
        incoming: [{ sha: '514d4f24', shortSha: '514d4f24', summary: 'c2 remote only (a.txt)' }],
        localModified: ['a.txt', 'b.txt'],
        incomingFiles: ['a.txt'],
        riskFiles: ['a.txt'],
        advice: 'commitOrStash',
      }
      // 等价真实 slice 行为：写分片，卡片才能读取渲染
      useGitStore.setState({
        conflictPrediction: prediction,
        conflictPredictionsByWs: { 'D:/repo': prediction },
      })
      return prediction
    })

    useGitStore.setState({
      getRemotes: getRemotes as unknown as GitState['getRemotes'],
      fetchRemote: fetchRemote as unknown as GitState['fetchRemote'],
      getBranches: getBranches as unknown as GitState['getBranches'],
      refreshStatus: refreshStatus as unknown as GitState['refreshStatus'],
      predictConflicts: predictConflicts as unknown as GitState['predictConflicts'],
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

    // FR-P2-AI4 冲突预测：fetch 后触发并渲染卡片
    await waitFor(() => {
      expect(predictConflicts).toHaveBeenCalledWith('D:/repo')
    })

    // 卡片展示风险文件（mock 返回 riskFiles=['a.txt']）
    expect(await screen.findByText('▸ a.txt')).toBeInTheDocument()
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