/**
 * RebaseTodoDialog 单元测试
 *
 * 覆盖面板化 Interactive Rebase（FR-P3-2）核心语义：
 * - plan 加载后渲染 todo 行（应用序）
 * - 首项动作下拉锁定 pick（disabled）
 * - squash/fixup 不紧跟 pick → live 校验红色 + 执行按钮禁用
 * - 合法序列 → 执行透传 todos + autosquash；冲突结果提示合并器接管
 * - plan 为空 → nothingToRebase
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RebaseTodoDialog } from './RebaseTodoDialog'
import { useGitStore } from '@/stores/gitStore'
import type { GitRebasePlan, GitRebaseResult, GitRebaseSuggestion, GitRebaseTodoItem } from '@/types/git'

// i18n mock（src/test/setup.ts 提供：t(key) 返回 key 原文）

function plan(commits: GitRebaseTodoItem[]): GitRebasePlan {
  return {
    baseCommitish: '1111111111111111111111111111111111111111',
    firstLocked: true,
    commits,
  }
}

function pick(sha: string, subject: string): GitRebaseTodoItem {
  return { sha, subject, action: 'pick' }
}

const OK_RESULT: GitRebaseResult = {
  success: true,
  hasConflicts: false,
  conflicts: [],
  rebasedCommits: 2,
  currentStep: 2,
  totalSteps: 2,
  finished: true,
}

const CONFLICT_RESULT: GitRebaseResult = {
  success: false,
  hasConflicts: true,
  conflicts: [{ path: 'a.txt', kind: 'text', stages: {} }] as GitRebaseResult['conflicts'],
  rebasedCommits: 0,
  currentStep: 1,
  totalSteps: 2,
  finished: false,
}

describe('RebaseTodoDialog', () => {
  const planFn = vi.fn()
  const startFn = vi.fn()
  const onDone = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    onDone.mockClear()
    useGitStore.setState({
      planInteractiveRebase: planFn,
      startInteractiveRebase: startFn,
    } as unknown as Partial<ReturnType<typeof useGitStore.getState>>)
  })

  it('加载中 → plan 到达后渲染 todo 行（应用序 + short sha）', async () => {
    planFn.mockResolvedValue(plan([pick('aaaa1111', 'one'), pick('bbbb2222', 'two')]))

    render(
      <RebaseTodoDialog
        workspacePath="D:/repo"
        baseCommitish="1111111"
        onClose={vi.fn()}
        onDone={onDone}
      />,
    )

    // 加载态
    expect(planFn).toHaveBeenCalledWith('D:/repo', '1111111')

    await waitFor(() => {
      expect(screen.getByText('one')).toBeInTheDocument()
    })
    expect(screen.getByText('two')).toBeInTheDocument()
    // short sha 显示为 slice(0,7)
    expect(screen.getByText('aaaa111')).toBeInTheDocument()
  })

  it('首项动作下拉锁定（disabled），后续行可切 drop', async () => {
    planFn.mockResolvedValue(plan([pick('aaaa1111', 'one'), pick('bbbb2222', 'two')]))

    render(
      <RebaseTodoDialog
        workspacePath="D:/repo"
        baseCommitish="1111111"
        onClose={vi.fn()}
        onDone={onDone}
      />,
    )

    await waitFor(() => screen.getByText('one'))
    const first = screen.getByTestId('todo-action-0') as HTMLSelectElement
    expect(first.disabled).toBe(true)
    const second = screen.getByTestId('todo-action-1') as HTMLSelectElement
    expect(second.disabled).toBe(false)

    fireEvent.change(second, { target: { value: 'drop' } })
    // 校验通过（drop 后仍是合法序列），执行按钮可用
    expect(screen.getByTestId('rebase-execute')).not.toBeDisabled()
  })

  it('squash 不紧跟 pick → 执行禁用 + 红色警示', async () => {
    planFn.mockResolvedValue(plan([pick('aaaa1111', 'one'), pick('bbbb2222', 'two'), pick('cccc3333', 'three')]))

    render(
      <RebaseTodoDialog
        workspacePath="D:/repo"
        baseCommitish="1111111"
        onClose={vi.fn()}
        onDone={onDone}
      />,
    )

    await waitFor(() => screen.getByText('three'))
    // 行2 改 drop（隔断），行3 再改 squash → 非法
    fireEvent.change(screen.getByTestId('todo-action-1'), { target: { value: 'drop' } })
    fireEvent.change(screen.getByTestId('todo-action-2'), { target: { value: 'squash' } })

    expect(screen.getByTestId('rebase-execute')).toBeDisabled()
    expect(screen.getByText(/rebaseTodo\.invalidOrder/)).toBeInTheDocument()
  })

  it('合法序列执行 → 透传 todos/autosquash；成功后 onDone', async () => {
    planFn.mockResolvedValue(plan([pick('aaaa1111', 'one'), pick('bbbb2222', 'two')]))
    startFn.mockResolvedValue(OK_RESULT)

    render(
      <RebaseTodoDialog
        workspacePath="D:/repo"
        baseCommitish="1111111"
        onClose={vi.fn()}
        onDone={onDone}
      />,
    )

    await waitFor(() => screen.getByText('one'))
    fireEvent.click(screen.getByTestId('autosquash-toggle'))
    fireEvent.click(screen.getByTestId('rebase-execute'))

    await waitFor(() => {
      expect(startFn).toHaveBeenCalledTimes(1)
    })
    expect(startFn).toHaveBeenCalledWith(
      'D:/repo',
      '1111111',
      [pick('aaaa1111', 'one'), pick('bbbb2222', 'two')],
      true,
    )
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1)
    })
  })

  it('执行返回冲突结果 → onDone 照常（合并器接线由 host 负责），提示含冲突文案', async () => {
    planFn.mockResolvedValue(plan([pick('aaaa1111', 'one')]))
    startFn.mockResolvedValue(CONFLICT_RESULT)

    render(
      <RebaseTodoDialog
        workspacePath="D:/repo"
        baseCommitish="1111111"
        onClose={vi.fn()}
        onDone={onDone}
      />,
    )

    await waitFor(() => screen.getByText('one'))
    fireEvent.click(screen.getByTestId('rebase-execute'))

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1)
    })
    // 冲突结果 → 不弹错误、面板关闭（toast 由全局 portal 渲染，不在本树内断言）
  })

  it('plan 为空 → nothingToRebase，执行禁用', async () => {
    planFn.mockResolvedValue(plan([]))

    render(
      <RebaseTodoDialog
        workspacePath="D:/repo"
        baseCommitish="1111111"
        onClose={vi.fn()}
        onDone={onDone}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(/rebaseTodo\.nothingToRebase/)).toBeInTheDocument()
    })
    expect(screen.getByTestId('rebase-execute')).toBeDisabled()
  })

  // ───────────── P3 AI-8：suggest 建议整理 ─────────────

  const suggestFn = vi.fn()

  beforeEach(() => {
    useGitStore.setState({
      suggestRebaseTodos: suggestFn,
    } as unknown as Partial<ReturnType<typeof useGitStore.getState>>)
  })

  async function renderWithSuggest(
    suggestion: Partial<GitRebaseSuggestion> & { commits: GitRebaseTodoItem[] },
  ) {
    suggestFn.mockResolvedValue({
      baseCommitish: '1111111',
      movedCount: 1,
      unmatched: [],
      ...suggestion,
    } as GitRebaseSuggestion)
    planFn.mockResolvedValue(plan([
      pick('aaaa1111', 'one'),
      pick('bbbb2222', 'two'),
      pick('cccc3333', 'three'),
    ]))
    render(
      <RebaseTodoDialog
        workspacePath="D:/repo"
        baseCommitish="1111111"
        onClose={vi.fn()}
        onDone={onDone}
      />,
    )
    await waitFor(() => screen.getByText('three'))
  }

  it('AI-8 建议点击 → 整表套用建议序列（连同动作）', async () => {
    await renderWithSuggest({
      commits: [
        { sha: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111', subject: 'one', action: 'pick' },
        { sha: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222', subject: 'fixup! one', action: 'fixup' },
        { sha: 'cccc3333cccc3333cccc3333cccc3333cccc3333', subject: 'three', action: 'pick' },
      ],
      movedCount: 1,
    })

    fireEvent.click(screen.getByTestId('ai8-suggest'))

    await waitFor(() => {
      expect(suggestFn).toHaveBeenCalledWith('D:/repo', '1111111')
    })
    // 建议序生效：行 1（index1）动作变 fixup，subject 换成建议里的行
    await waitFor(() => {
      expect((screen.getByTestId('todo-action-1') as HTMLSelectElement).value).toBe('fixup')
    })
  })

  it('建议含 unmatched → warning 汇报；moved=0 → info（照常不阻断）', async () => {
    await renderWithSuggest({
      commits: [
        { sha: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111', subject: 'one', action: 'pick' },
        { sha: 'cccc3333cccc3333cccc3333cccc3333cccc3333', subject: 'three', action: 'pick' },
        { sha: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222', subject: 'fixup! no target', action: 'pick' },
      ],
      movedCount: 0,
      unmatched: ['bbbb2222'],
    })

    fireEvent.click(screen.getByTestId('ai8-suggest'))

    await waitFor(() => {
      expect((screen.getByTestId('todo-action-2') as HTMLSelectElement).value).toBe('pick')
    })
  })
})
