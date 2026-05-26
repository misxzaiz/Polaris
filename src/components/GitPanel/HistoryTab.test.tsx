import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HistoryTab } from './HistoryTab'
import { useGitStore } from '@/stores/gitStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { GitBranch, GitCommit, GitCommitDetails, GitDiffEntry, GitFileHistoryEntry } from '@/types/git'
import type { GitState } from '@/stores/gitStore'

vi.mock('@/components/Diff/DiffViewer', () => ({
  DiffViewer: ({ viewMode }: { viewMode?: string }) => (
    <div data-testid="diff-viewer" data-view-mode={viewMode} />
  ),
}))

const commits: GitCommit[] = [
  {
    sha: '1111111111111111111111111111111111111111',
    shortSha: '1111111',
    message: 'Fix search panel',
    author: 'Alice',
    authorEmail: 'alice@example.com',
    timestamp: 1_700_000_000,
    parents: ['0000000000000000000000000000000000000000'],
  },
  {
    sha: '2222222222222222222222222222222222222222',
    shortSha: '2222222',
    message: 'Add command bridge',
    author: 'Bob',
    authorEmail: 'bob@example.com',
    timestamp: 1_700_000_100,
    parents: ['1111111111111111111111111111111111111111'],
  },
]

const branches: GitBranch[] = [
  {
    name: 'main',
    isCurrent: true,
    isRemote: false,
    commit: commits[0].sha,
  },
  {
    name: 'feature/history',
    isCurrent: false,
    isRemote: false,
    commit: commits[1].sha,
  },
]

const changedFiles: GitDiffEntry[] = [
  {
    file_path: 'src/App.tsx',
    change_type: 'modified',
    old_content: 'old',
    new_content: 'new',
    additions: 2,
    deletions: 1,
    is_binary: false,
  },
  {
    file_path: 'src/components/GitPanel/HistoryTab.tsx',
    change_type: 'modified',
    old_content: 'old history',
    new_content: 'new history',
    additions: 5,
    deletions: 2,
    is_binary: false,
  },
  {
    file_path: 'README.md',
    change_type: 'added',
    new_content: 'readme',
    additions: 1,
    deletions: 0,
    is_binary: false,
  },
]

const detailsFor = (commit: GitCommit): GitCommitDetails => ({
  commit,
  files: changedFiles,
  totalAdditions: 8,
  totalDeletions: 3,
})

const fileHistoryEntries: GitFileHistoryEntry[] = [
  {
    commit: commits[0],
    file: changedFiles[0],
  },
  {
    commit: commits[1],
    file: {
      ...changedFiles[0],
      old_content: 'older',
      new_content: 'old',
      additions: 1,
      deletions: 1,
    },
  },
]

describe('HistoryTab', () => {
  const getLog = vi.fn()
  const getCommitDetails = vi.fn()
  const getFileHistory = vi.fn()
  const getBranches = vi.fn()
  const clipboardWriteText = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    clipboardWriteText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWriteText },
      configurable: true,
    })

    getLog.mockResolvedValue(commits)
    getFileHistory.mockResolvedValue(fileHistoryEntries)
    getBranches.mockResolvedValue(undefined)
    getCommitDetails.mockImplementation((_workspacePath: string, sha: string) => {
      const commit = commits.find((item) => item.sha === sha) ?? commits[0]
      return Promise.resolve(detailsFor(commit))
    })

    useGitStore.setState({
      getLog: getLog as unknown as GitState['getLog'],
      getCommitDetails: getCommitDetails as unknown as GitState['getCommitDetails'],
      getFileHistory: getFileHistory as unknown as GitState['getFileHistory'],
      getBranches: getBranches as unknown as GitState['getBranches'],
      branches,
      status: {
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: [],
      } as unknown as GitState['status'],
      commitDetails: {},
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

  it('filters loaded commits by search query and can clear the search', async () => {
    render(<HistoryTab />)

    expect(await screen.findByText('Fix search panel')).toBeInTheDocument()
    expect(screen.getByText('Add command bridge')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('history.searchPlaceholder'), {
      target: { value: 'bridge' },
    })

    await waitFor(() => {
      expect(screen.queryByText('Fix search panel')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Add command bridge')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('history.clearSearch'))

    expect(await screen.findByText('Fix search panel')).toBeInTheDocument()
  })

  it('filters commit history by branch without checking out that branch', async () => {
    render(<HistoryTab variant="workbench" />)

    await waitFor(() => {
      expect(getBranches).toHaveBeenCalledWith('D:/repo')
    })
    await waitFor(() => {
      expect(getLog).toHaveBeenCalledWith('D:/repo', 20, 0, undefined)
    })

    fireEvent.change(screen.getByLabelText('history.branchFilter'), {
      target: { value: 'feature/history' },
    })

    await waitFor(() => {
      expect(getLog).toHaveBeenLastCalledWith('D:/repo', 20, 0, 'feature/history')
    })

    await waitFor(() => {
      expect(screen.getAllByTitle('history.viewFileHistory').length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getAllByTitle('history.viewFileHistory')[0])

    await waitFor(() => {
      expect(getFileHistory).toHaveBeenLastCalledWith('D:/repo', 'src/App.tsx', 20, 0, 'feature/history')
    })
  })

  it('auto-selects the latest commit in workbench mode and can close details', async () => {
    render(<HistoryTab variant="workbench" />)

    await waitFor(() => {
      expect(getCommitDetails).toHaveBeenCalledWith('D:/repo', commits[0].sha)
    })

    expect((await screen.findAllByText('src/App.tsx')).length).toBeGreaterThan(0)
    expect(screen.getByTestId('diff-viewer')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('history.closeDetails'))

    expect(await screen.findByText('history.selectCommit')).toBeInTheDocument()
  })

  it('supports commit copy actions plus changed-file search and tree view', async () => {
    render(<HistoryTab variant="workbench" />)

    await waitFor(() => {
      expect(getCommitDetails).toHaveBeenCalledWith('D:/repo', commits[0].sha)
    })

    fireEvent.click(screen.getByTitle('history.copySha'))

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(commits[0].sha)
    })
    expect(screen.getByTitle('history.copied')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('history.fileSearchPlaceholder'), {
      target: { value: 'HistoryTab' },
    })

    await waitFor(() => {
      expect(screen.queryByText('README.md')).not.toBeInTheDocument()
    })
    expect(screen.getAllByText('src/components/GitPanel/HistoryTab.tsx').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTitle('history.treeView'))

    expect(screen.getByText('src/components/GitPanel')).toBeInTheDocument()
  })

  it('does not show copied state when clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    })

    render(<HistoryTab variant="workbench" />)

    await waitFor(() => {
      expect(getCommitDetails).toHaveBeenCalledWith('D:/repo', commits[0].sha)
    })

    fireEvent.click(screen.getByTitle('history.copySha'))

    expect(screen.queryByTitle('history.copied')).not.toBeInTheDocument()
    expect(screen.getByTitle('history.copySha')).toBeInTheDocument()
  })

  it('cleans up pane resize cursor state on pointer up', async () => {
    render(<HistoryTab variant="workbench" />)

    await waitFor(() => {
      expect(getCommitDetails).toHaveBeenCalledWith('D:/repo', commits[0].sha)
    })

    fireEvent.pointerDown(screen.getAllByTitle('history.resizePane')[0], { clientX: 0 })

    expect(document.body.style.cursor).toBe('col-resize')

    fireEvent.pointerUp(window)

    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('switches the selected file diff between unified and split views', async () => {
    render(<HistoryTab variant="workbench" />)

    await waitFor(() => {
      expect(getCommitDetails).toHaveBeenCalledWith('D:/repo', commits[0].sha)
    })

    expect(screen.getByTestId('diff-viewer')).toHaveAttribute('data-view-mode', 'unified')

    fireEvent.click(screen.getByTitle('diff.splitView'))

    expect(screen.getByTestId('diff-viewer')).toHaveAttribute('data-view-mode', 'split')
  })

  it('opens the selected history file in the editor with a workspace path', async () => {
    const onOpenFileInEditor = vi.fn()
    render(<HistoryTab variant="workbench" onOpenFileInEditor={onOpenFileInEditor} />)

    await waitFor(() => {
      expect(getCommitDetails).toHaveBeenCalledWith('D:/repo', commits[0].sha)
    })

    fireEvent.click(screen.getByTitle('history.openFileInEditor'))

    expect(onOpenFileInEditor).toHaveBeenCalledWith('D:/repo/src/App.tsx')
  })

  it('opens history diffs with commit-scoped tab identity', async () => {
    const onOpenDiffInTab = vi.fn()
    render(<HistoryTab variant="workbench" onOpenDiffInTab={onOpenDiffInTab} />)

    await waitFor(() => {
      expect(getCommitDetails).toHaveBeenCalledWith('D:/repo', commits[0].sha)
    })

    fireEvent.click(screen.getByTitle('history.openDiffInEditor'))

    expect(onOpenDiffInTab).toHaveBeenCalledWith(
      changedFiles[0],
      expect.objectContaining({
        identity: `history:${commits[0].sha}::src/App.tsx`,
        titleContext: commits[0].shortSha,
        metadata: expect.objectContaining({
          commitSha: commits[0].sha,
          source: 'commit-history',
        }),
      })
    )
  })

  it('keeps multiline commit messages collapsed until requested', async () => {
    const multilineCommit = {
      ...commits[0],
      message: 'Fix search panel\n\n- Keep the body out of the way',
    }
    getCommitDetails.mockResolvedValueOnce(detailsFor(multilineCommit))

    render(<HistoryTab variant="workbench" />)

    await waitFor(() => {
      expect(getCommitDetails).toHaveBeenCalledWith('D:/repo', commits[0].sha)
    })

    const bodyMatcher = (_content: string, node: Element | null) => {
      return node?.textContent?.includes('- Keep the body out of the way') ?? false
    }

    expect(screen.queryAllByText(bodyMatcher)).toHaveLength(0)

    fireEvent.click(screen.getByTitle('history.expandMessage'))

    expect(screen.queryAllByText(bodyMatcher).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTitle('history.collapseMessage'))

    expect(screen.queryAllByText(bodyMatcher)).toHaveLength(0)
  })

  it('opens a focused file history view from a changed file and can return', async () => {
    render(<HistoryTab variant="workbench" />)

    await waitFor(() => {
      expect(getCommitDetails).toHaveBeenCalledWith('D:/repo', commits[0].sha)
    })

    fireEvent.click(screen.getAllByTitle('history.viewFileHistory')[0])

    await waitFor(() => {
      expect(getFileHistory).toHaveBeenCalledWith('D:/repo', 'src/App.tsx', 20, 0, undefined)
    })

    expect(await screen.findByText('history.fileHistoryTitle')).toBeInTheDocument()
    expect(screen.getAllByText('src/App.tsx').length).toBeGreaterThan(0)
    expect(screen.getByPlaceholderText('history.fileHistorySearchPlaceholder')).toBeInTheDocument()
    expect(screen.getByTestId('diff-viewer')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('history.backToCommitHistory'))

    expect(await screen.findByText('history.title')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('history.searchPlaceholder')).toBeInTheDocument()
  })
})
