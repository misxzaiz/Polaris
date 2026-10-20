/**
 * UndoBar 单元测试（FR-P2-3 收尾：可撤销快照条）
 *
 * - 无快照 → 不渲染
 * - 快照 >0 → 计数 + 折叠显示最新 1 条；展开显示至多 3 条 + more 折叠计数
 * - 恢复成功 → toast.success；冲突 → warning；刷新列表
 * - 丢弃两步确认 → 第二次点击才调用 drop
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { UndoBar } from './UndoBar'
import { useGitStore } from '@/stores/gitStore'
import { useToastStore } from '@/stores/toastStore'
import type { UndoSnapshotMeta } from '@/types/git'

function snap(id: number, context: string, hasChanges = false): UndoSnapshotMeta {
  return {
    name: `refs/polaris-undo/D:/repo/${id}`,
    createdAt: 1735000000 + id,
    context,
    hasChanges,
    branch: 'main',
  }
}

describe('UndoBar', () => {
  const listFn = vi.fn()
  const restoreFn = vi.fn()
  const dropFn = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    useGitStore.setState({
      listUndoSnapshots: listFn,
      restoreUndoSnapshot: restoreFn,
      dropUndoSnapshot: dropFn,
      undoSnapshots: [],
      undoSnapshotsByWs: {},
    } as unknown as Partial<ReturnType<typeof useGitStore.getState>>)
    useToastStore.setState({
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    } as unknown as Partial<ReturnType<typeof useToastStore.getState>>)
  })

  it('拉取为空 → 不渲染', async () => {
    listFn.mockResolvedValue([])
    const { container } = render(<UndoBar workspacePath="D:/repo" />)
    await waitFor(() => {
      expect(listFn).toHaveBeenCalledWith('D:/repo')
    })
    expect(container.querySelector('[data-testid="undo-bar"]')).toBeNull()
  })

  it('快照 >0 → 计数 + 折叠态显示最新 1 条；展开至多 3 条 + more', async () => {
    const snaps = [snap(3, 'discard'), snap(2, 'reset_hard'), snap(1, 'rebase'), snap(0, 'branch_delete')]
    listFn.mockResolvedValue(snaps)

    // 预注入（对齐真实 slice listUndoSnapshots 写回 undoSnapshotsByWs 的行为）
    useGitStore.setState((s) => ({
      undoSnapshotsByWs: { ...(s.undoSnapshotsByWs ?? {}), 'D:/repo': snaps },
    }))

    render(<UndoBar workspacePath="D:/repo" />)

    expect(await screen.findByText(/undo\.title/)).toBeInTheDocument()

    // 折叠态：只 1 行
    expect(screen.getAllByTestId('undo-row')).toHaveLength(1)
    expect(screen.getByText(/undo\.ctx\.discard/)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('undo-bar-toggle'))
    // 展开态：最多 3 行 + more 折叠计数（4 条 - 3 = 1）
    expect(screen.getAllByTestId('undo-row')).toHaveLength(3)
    expect(screen.getByText(/undo\.more/)).toBeInTheDocument()
  })

  it('恢复成功 → restoreUndoSnapshot 调用 + 列表刷新', async () => {
    listFn.mockResolvedValue([snap(2, 'discard')])
    restoreFn.mockResolvedValue({ ok: true, conflictedFiles: [], conflictMessage: null })

    useGitStore.setState((s) => ({
      undoSnapshotsByWs: { ...(s.undoSnapshotsByWs ?? {}), 'D:/repo': [snap(2, 'discard')] },
    }))

    render(<UndoBar workspacePath="D:/repo" />)
    expect(await screen.findByTestId('undo-bar')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('undo-restore'))
    await waitFor(() => {
      expect(restoreFn).toHaveBeenCalledWith('D:/repo', 'refs/polaris-undo/D:/repo/2')
    })
    await waitFor(() => {
      expect(listFn).toHaveBeenCalledTimes(2) // 挂载 + 恢复后刷新
    })
  })

  it('丢弃两步确认：第一次只进确认态，第二次才 drop', async () => {
    listFn.mockResolvedValue([snap(1, 'checked_out')])
    dropFn.mockResolvedValue(undefined)

    useGitStore.setState((s) => ({
      undoSnapshotsByWs: { ...(s.undoSnapshotsByWs ?? {}), 'D:/repo': [snap(1, 'checked_out')] },
    }))

    render(<UndoBar workspacePath="D:/repo" />)
    expect(await screen.findByTestId('undo-bar')).toBeInTheDocument()

    const dropBtn = screen.getByTestId('undo-drop')
    fireEvent.click(dropBtn)
    expect(dropFn).not.toHaveBeenCalled()

    fireEvent.click(dropBtn)
    await waitFor(() => {
      expect(dropFn).toHaveBeenCalledWith('D:/repo', 'refs/polaris-undo/D:/repo/1')
    })
  })
})
