import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HistoryTab } from './HistoryTab'
import { useGitStore } from '@/stores/gitStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { GitBranch, GitCommit, GitCommitDetails, GitDiffEntry, GitFileHistoryEntry, GitReflogEntry } from '@/types/git'
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
  const getLogWithLanes = vi.fn()
  const getCommitDetails = vi.fn()
  const getFileHistory = vi.fn()
  const getBranches = vi.fn()
  const searchLog = vi.fn()
  const getReflog = vi.fn()
  const checkoutCommit = vi.fn()
  const refreshStatus = vi.fn()
  const clipboardWriteText = vi.fn()
  const getStashList = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    clipboardWriteText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWriteText },
      configurable: true,
    })

    getLogWithLanes.mockResolvedValue({ commits, rows: [] })
    getFileHistory.mockResolvedValue(fileHistoryEntries)
    getBranches.mockResolvedValue(undefined)
    getCommitDetails.mockImplementation((_workspacePath: string, sha: string) => {
      const commit = commits.find((item) => item.sha === sha) ?? commits[0]
      return Promise.resolve(detailsFor(commit))
    })

    searchLog.mockResolvedValue(commits)
    getReflog.mockResolvedValue(reflogEntries)
    checkoutCommit.mockResolvedValue(undefined)
    refreshStatus.mockResolvedValue(undefined)
    getStashList.mockResolvedValue([])

    useGitStore.setState({
      getLogWithLanes: getLogWithLanes as unknown as GitState['getLogWithLanes'],
      getCommitDetails: getCommitDetails as unknown as GitState['getCommitDetails'],
      getFileHistory: getFileHistory as unknown as GitState['getFileHistory'],
      getBranches: getBranches as unknown as GitState['getBranches'],
      searchLog: searchLog as unknown as GitState['searchLog'],
      getReflog: getReflog as unknown as GitState['getReflog'],
      checkoutCommit: checkoutCommit as unknown as GitState['checkoutCommit'],
      refreshStatus: refreshStatus as unknown as GitState['refreshStatus'],
      getStashList: getStashList as unknown as GitState['getStashList'],
      branches,
      status: {
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: [],
      } as unknown as GitState['status'],
      statuses: {
        'D:/repo': {
          branch: 'main',
          commit: '1111111111111111111111111111111111111111',
          shortCommit: '1111111',
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [],
          untracked: [],
          conflicted: [],
          isEmpty: false,
        } as GitState['statuses'][string],
      },
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
      expect(getLogWithLanes).toHaveBeenCalledWith('D:/repo', 50, 0, undefined)
    })

    // branchFilter 是自定义下拉按钮（73715eee 起由原生 select 改造），用 change 事件无法触发
    fireEvent.click(screen.getByLabelText('history.branchFilter'))
    fireEvent.click(screen.getAllByRole('option').find((el) => el.textContent === 'feature/history')!)

    await waitFor(() => {
      expect(getLogWithLanes).toHaveBeenLastCalledWith('D:/repo', 50, 0, 'feature/history')
    })

    await waitFor(() => {
      expect(screen.getAllByTitle('history.viewFileHistory').length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getAllByTitle('history.viewFileHistory')[0])

    await waitFor(() => {
      expect(getFileHistory).toHaveBeenLastCalledWith('D:/repo', 'src/App.tsx', 50, 0, 'feature/history')
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

  it('collapses and restores the changed files pane in workbench mode', async () => {
    render(<HistoryTab variant="workbench" />)

    await waitFor(() => {
      expect(getCommitDetails).toHaveBeenCalledWith('D:/repo', commits[0].sha)
    })

    expect(screen.getAllByTitle('history.viewFileHistory').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTitle('history.collapseFilePane'))

    expect(screen.queryByTitle('history.viewFileHistory')).not.toBeInTheDocument()
    expect(screen.getByTitle('history.expandFilePane')).toBeInTheDocument()
    expect(window.localStorage.getItem('polaris.git.history.filePaneCollapsed')).toBe('true')

    fireEvent.click(screen.getByTitle('history.expandFilePane'))

    expect(screen.getAllByTitle('history.viewFileHistory').length).toBeGreaterThan(0)
    expect(window.localStorage.getItem('polaris.git.history.filePaneCollapsed')).toBe('false')
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

  it('opens a history file diff directly in the editor from the sidebar', async () => {
    const onOpenDiffInTab = vi.fn()
    render(<HistoryTab onOpenDiffInTab={onOpenDiffInTab} />)

    fireEvent.click(await screen.findByText('Fix search panel'))

    await waitFor(() => {
      expect(getCommitDetails).toHaveBeenCalledWith('D:/repo', commits[0].sha)
    })

    fireEvent.click(await screen.findByText('src/App.tsx'))

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

  it('collapses the inline file list when the selected commit is clicked again', async () => {
    render(<HistoryTab />)

    fireEvent.click(await screen.findByText('Fix search panel'))

    expect(await screen.findByText('src/App.tsx')).toBeInTheDocument()

    // 点击行内 subject（展开面板 message 区也含该文本，getByText 会命中多选；用行内第一条）
    fireEvent.click(screen.getAllByText('Fix search panel')[0])

    await waitFor(() => {
      expect(screen.queryByText('src/App.tsx')).not.toBeInTheDocument()
    })
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

  it('shows inline commit message body (≤clamp lines) in sidebar detail without a toggle', async () => {
    const commitWithShortBody = {
      ...commits[0],
      message: 'Fix search panel\n\n- Short body, fits inline',
    }
    getCommitDetails.mockResolvedValueOnce(detailsFor(commitWithShortBody))

    render(<HistoryTab />)

    // sidebar 形态：点行触发就地展开
    fireEvent.click(await screen.findByText('Fix search panel'))

    // 短 body 直接显示（不经过 clamp）
    expect(await screen.findByText(/- Short body, fits inline/)).toBeInTheDocument()
    // 短 body 无「展开全文」按钮
    expect(screen.queryAllByTitle('history.expandMessage')).toHaveLength(0)
  })

  it('clamps a long inline body in sidebar detail and expands on demand', async () => {
    // 超 clamp 阈值（5 行）的长 body
    const longBody = Array.from({ length: 12 }, (_, i) => `- body line ${i + 1}`).join('\n')
    const commitWithLongBody = {
      ...commits[0],
      message: `Fix search panel\n\n${longBody}`,
    }
    getCommitDetails.mockResolvedValueOnce(detailsFor(commitWithLongBody))

    render(<HistoryTab />)

    fireEvent.click(await screen.findByText('Fix search panel'))

    // body 折叠态：clamped class 挂在 message body 容器（多行 body 是单个文本节点，需用正则匹配）
    const bodyEl = await screen.findByText(/- body line 1/)
    expect(bodyEl.className).toContain('clamped')
    // 有「展开全文」按钮
    const expandBtn = screen.getByTitle('history.expandMessage')
    expect(expandBtn).toBeInTheDocument()

    fireEvent.click(expandBtn)

    // 展开 → 容器进入 expanded 滚动态
    expect(bodyEl.className).toContain('expanded')
    // 按钮变「折叠」
    expect(screen.getByTitle('history.collapseMessage')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('history.collapseMessage'))
    expect(screen.queryByTitle('history.collapseMessage')).not.toBeInTheDocument()
  })

  it('opens a focused file history view from a changed file and can return', async () => {
    render(<HistoryTab variant="workbench" />)

    await waitFor(() => {
      expect(getCommitDetails).toHaveBeenCalledWith('D:/repo', commits[0].sha)
    })

    fireEvent.click(screen.getAllByTitle('history.viewFileHistory')[0])

    await waitFor(() => {
      expect(getFileHistory).toHaveBeenCalledWith('D:/repo', 'src/App.tsx', 50, 0, undefined)
    })

    expect(await screen.findByText('history.fileHistoryTitle')).toBeInTheDocument()
    expect(screen.getAllByText('src/App.tsx').length).toBeGreaterThan(0)
    expect(screen.getByPlaceholderText('history.fileHistorySearchPlaceholder')).toBeInTheDocument()
    expect(screen.getByTestId('diff-viewer')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('history.backToCommitHistory'))

    expect(await screen.findByText('history.title')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('history.searchPlaceholder')).toBeInTheDocument()
  })

  it('enters and exits the reflog view via the reflog button', async () => {
    render(<HistoryTab variant="workbench" />)

    await waitFor(() => {
      expect(getCommitDetails).toHaveBeenCalledWith('D:/repo', commits[0].sha)
    })

    // 进入 reflog 模式
    fireEvent.click(screen.getByTitle('history.reflogTitle'))

    expect(await screen.findByText(/Add reflog panel/)).toBeInTheDocument()
    expect(getReflog).toHaveBeenCalledWith('D:/repo', null, 100)

    // 退出回提交历史
    fireEvent.click(screen.getByTitle('history.backToCommitHistory'))

    expect(await screen.findByPlaceholderText('history.searchPlaceholder')).toBeInTheDocument()
  })

  it('triggers exact search via searchLog when the exact toggle is on', async () => {
    render(<HistoryTab variant="workbench" />)

    await waitFor(() => {
      expect(getCommitDetails).toHaveBeenCalledWith('D:/repo', commits[0].sha)
    })

    // 打开精确搜索 toggle
    fireEvent.click(screen.getByTitle('history.searchExactDesc'))

    // 输入查询词
    fireEvent.change(screen.getByPlaceholderText('history.searchPlaceholder'), {
      target: { value: 'bridge' },
    })

    await waitFor(() => {
      expect(searchLog).toHaveBeenCalledWith(
        'D:/repo',
        expect.objectContaining({
          grep: 'bridge',
          range: undefined,
        }),
        100,
        0,
      )
    })
  })

  // ── P2 增量：泳道图语义着色 + WIP/stash 虚拟节点 ─────────────────────

  it('renders a WIP virtual lane row when the working tree is dirty', async () => {
    // 脏工作区：statuses 有 staged/unstaged
    useGitStore.setState({
      statuses: {
        'D:/repo': {
          branch: 'main',
          commit: '1111111111111111111111111111111111111111',
          shortCommit: '1111111',
          ahead: 0,
          behind: 0,
          staged: [{ file_path: 'a.ts', change_type: 'modified' }],
          unstaged: [{ file_path: 'b.ts', change_type: 'modified' }],
          untracked: ['c.ts'],
          conflicted: [],
          isEmpty: false,
        } as GitState['statuses'][string],
      },
    })

    render(<HistoryTab />)

    expect(await screen.findByText('Fix search panel')).toBeInTheDocument()
    // WIP 虚拟行：`WIP` 标签 + 未提交改动文案（i18n key）
    expect(screen.getByText('WIP')).toBeInTheDocument()
    expect(screen.getByText(/lane\.wipCount/)).toBeInTheDocument()
    // 图例 4 色说明出现
    expect(screen.getByText('lane.legendLocal')).toBeInTheDocument()
    expect(screen.getByText('lane.legendUnpushed')).toBeInTheDocument()
    expect(screen.getByText('lane.legendMerged')).toBeInTheDocument()
    expect(screen.getByText('lane.legendDim')).toBeInTheDocument()
  })

  it('does not render WIP/stash rows when tree is clean and no stash', async () => {
    useGitStore.setState({
      statuses: {
        'D:/repo': {
          branch: 'main',
          commit: '1111111111111111111111111111111111111111',
          shortCommit: '1111111',
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [],
          untracked: [],
          conflicted: [],
          isEmpty: false,
        } as GitState['statuses'][string],
      },
      stashListByWs: {},
    })

    render(<HistoryTab />)
    expect(await screen.findByText('Fix search panel')).toBeInTheDocument()
    expect(screen.queryByText('WIP')).not.toBeInTheDocument()
    expect(screen.queryByText(/^stash/)).not.toBeInTheDocument()
    // P2 起图例常显（不依赖 WIP/stash 虚拟行存在）
    expect(screen.getByText('lane.legendLocal')).toBeInTheDocument()
  })

  it('renders a stash virtual row from stashListByWs', async () => {
    useGitStore.setState({
      statuses: {
        'D:/repo': {
          branch: 'main',
          commit: '1111111111111111111111111111111111111111',
          shortCommit: '1111111',
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [],
          untracked: [],
          conflicted: [],
          isEmpty: false,
        } as GitState['statuses'][string],
      },
      stashListByWs: {
        'D:/repo': [{ index: 0, message: 'WIP on main: stash test', branch: 'main', commitSha: '4444444', timestamp: 1_700_000_300 }],
      },
    })

    render(<HistoryTab />)
    expect(await screen.findByText('Fix search panel')).toBeInTheDocument()
    // stash 行：stash@{0} 前缀 + message
    expect(screen.getByText(/stash@\{0\}/)).toBeInTheDocument()
    expect(screen.getByText(/stash test/)).toBeInTheDocument()
  })

  it('passes semantic color to LaneGraph when backend provides semantic', async () => {
    const semantic = [
      { kind: 'unpushed' as const },
      { kind: 'local' as const },
    ]
    // rows 需要与 commits 一一对应（LaneGraph 渲染依赖 laneRow）
    const rows = [
      { sha: commits[0].sha, cells: [{ lane: 0, node: 'commit' as const, edgeDown: null, edgeUp: null }], refs: [] },
      { sha: commits[1].sha, cells: [{ lane: 0, node: 'commit' as const, edgeDown: null, edgeUp: null }], refs: [] },
    ]
    getLogWithLanes.mockResolvedValueOnce({ commits, rows, semantic })

    render(<HistoryTab />)
    expect(await screen.findByText('Fix search panel')).toBeInTheDocument()

    // 第一个 commit 未 push → LaneGraph 节点红（text-danger class）
    const nodes = Array.from(document.querySelectorAll('circle'))
    expect(nodes.length).toBeGreaterThan(0)
    expect(nodes.some((n) => n.getAttribute('class')?.includes('text-danger'))).toBe(true)
  })
})
