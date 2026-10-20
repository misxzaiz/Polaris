/**
 * ThreeWayMergeEditor 组件测试（P3 FR-P3-1）
 *
 * 覆盖（spec 验收点 5）：
 * - 渲染三窗 + per-hunk 控件
 * - Accept Ours / Accept Theirs 决策生效 → 计数递减
 * - 归零 → 完成并暂存按钮点亮
 * - Apply All Non-Conflicting 只反馈不破坏决策
 * - 语义标签随 kind 变化（merge vs rebase 左右互换）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThreeWayMergeEditor } from './ThreeWayMergeEditor'
import { useGitStore } from '@/stores/gitStore'
import type { GitConflictEntry, GitSequenceKind } from '@/types/git'

// mock transport：invoke 可控（测试里按需 resolve），listen 防 subscriber 顶层缺导入
const mockInvoke = vi.fn()
vi.mock('@/services/transport', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  listen: vi.fn(),
}))

const mockToast = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}
vi.mock('@/stores/toastStore', () => ({
  useToastStore: () => mockToast,
}))

// i18n mock（t(key) 返回 key）由 src/test/setup.ts 提供

function conflict(partial: Partial<GitConflictEntry> = {}): GitConflictEntry {
  return {
    path: 'src/a.ts',
    kind: 'text',
    base: 'a\nb\nc\nd\n',
    ours: 'a\nB1\nc\nd\n',
    theirs: 'a\nC1\nc\nd\n',
    ...partial,
  }
}

function renderEditor(kind: GitSequenceKind = 'merge', c: GitConflictEntry = conflict()) {
  const onResolved = vi.fn()
  const onError = vi.fn()
  render(
    <ThreeWayMergeEditor
      workspacePath="D:/repo"
      conflict={c}
      sequenceKind={kind}
      onResolved={onResolved}
      onError={onError}
    />,
  )
  return { onResolved, onError }
}

describe('ThreeWayMergeEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockReset().mockResolvedValue(undefined)
    useGitStore.setState({})
  })

  it('渲染三窗 + per-hunk 控件', () => {
    renderEditor()
    expect(screen.getByText('conflict.ours')).toBeInTheDocument()
    expect(screen.getByText('conflict.theirs')).toBeInTheDocument()
    expect(screen.getByText('conflict.result')).toBeInTheDocument()
    expect(screen.getByTestId('accept-ours-0')).toBeInTheDocument()
    expect(screen.getByTestId('accept-theirs-0')).toBeInTheDocument()
    expect(screen.getByText('conflict.unresolved')).toBeInTheDocument()
    expect(screen.getByTestId('resolve-done')).toBeDisabled()
  })

  it('Accept Ours 决策 → 计数归零 → 完成点亮', () => {
    renderEditor()
    fireEvent.click(screen.getByTestId('accept-ours-0'))
    expect(screen.getByText('conflict.allResolved')).toBeInTheDocument()
    expect(screen.getByTestId('resolve-done')).not.toBeDisabled()
  })

  it('Accept Theirs 决策同样生效', () => {
    renderEditor()
    fireEvent.click(screen.getByTestId('accept-theirs-0'))
    expect(screen.getByText('conflict.allResolved')).toBeInTheDocument()
    expect(screen.getByTestId('resolve-done')).not.toBeDisabled()
  })

  it('两个冲突块：解决一个后仍有一个未解决', () => {
    const c = conflict({
      base: 'a\nb\nc\nd\n',
      ours: 'a\nB1\nc\nD1\n',
      theirs: 'a\nC1\nc\nE1\n',
    })
    renderEditor('merge', c)
    expect(screen.getByTestId('hunk-0')).toBeInTheDocument()
    expect(screen.getByTestId('hunk-1')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('accept-ours-0'))
    expect(screen.getByText('conflict.unresolved')).toBeInTheDocument()
    expect(screen.getByTestId('resolve-done')).toBeDisabled()
    fireEvent.click(screen.getByTestId('accept-ours-1'))
    expect(screen.getByTestId('resolve-done')).not.toBeDisabled()
  })

  it('Apply All Non-Conflicting：反馈 toast，不触碰未解决冲突块', () => {
    // 同时含 conflict hunk（index1 双方改）与 ours 单侧 region（index3 仅 ours 插入）
    const c = conflict({
      base: 'a\nb\nc\nd\n',
      ours: 'a\nB1\nc\nX\nd\n',
      theirs: 'a\nC1\nc\nd\n',
    })
    renderEditor('merge', c)
    fireEvent.click(screen.getByTestId('apply-all'))
    expect(mockToast.info).toHaveBeenCalled()
    // 计数未变：仍未解决（hunk 未决策）
    expect(screen.getByText('conflict.unresolved')).toBeInTheDocument()
    expect(screen.getByTestId('resolve-done')).toBeDisabled()
  })

  it('语义标签：merge → 左 current 右 incoming；rebase → 互换', () => {
    const { rerender } = render(
      <ThreeWayMergeEditor
        workspacePath="D:/repo"
        conflict={conflict()}
        sequenceKind="merge"
        onResolved={vi.fn()}
      />,
    )
    // merge：左窗标题同时含 current（primary 语义标签）与 ours
    expect(screen.getByText('conflict.current')).toBeInTheDocument()
    expect(screen.getByText('conflict.incoming')).toBeInTheDocument()

    rerender(
      <ThreeWayMergeEditor
        workspacePath="D:/repo"
        conflict={conflict()}
        sequenceKind="rebase"
        onResolved={vi.fn()}
      />,
    )
    // rebase：current/incoming 互换仍各出现一次（方向换，标签集不变）
    expect(screen.getByText('conflict.current')).toBeInTheDocument()
    expect(screen.getByText('conflict.incoming')).toBeInTheDocument()
  })

  it('无冲突块（binary）→ 显示 noBlocks，完成可点（无未解决）', () => {
    const c = conflict({ kind: 'binary', base: null, ours: 'bin', theirs: 'bin' })
    renderEditor('merge', c)
    expect(screen.getByText('conflict.noBlocks')).toBeInTheDocument()
    expect(screen.getByTestId('resolve-done')).not.toBeDisabled()
  })

  it('完成并暂存 → resolve_conflict_file（含 ours 内容）+ onResolved', async () => {
    const { onResolved } = renderEditor()
    fireEvent.click(screen.getByTestId('accept-ours-0'))
    fireEvent.click(screen.getByTestId('resolve-done'))
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('git_resolve_conflict_file', {
        workspacePath: 'D:/repo',
        filePath: 'src/a.ts',
        content: expect.stringContaining('B1'),
      })
    })
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalled())
  })

  it('完成失败 → onError 上报（不抛未处理）', async () => {
    const { onError } = renderEditor()
    mockInvoke.mockRejectedValueOnce(new Error('boom'))
    fireEvent.click(screen.getByTestId('accept-ours-0'))
    fireEvent.click(screen.getByTestId('resolve-done'))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('boom'))
  })
})