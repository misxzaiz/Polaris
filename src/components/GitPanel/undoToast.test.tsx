/**
 * undoToast 单元测试（A3：危险操作成功 toast 携「撤销」按钮）
 *
 * - 有快照 → addToast 带 action
 * - 无快照 → 普通 success toast
 * - action 点击 → restoreUndoSnapshot；恢复冲突 → warning
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { toastWithUndo } from './undoToast'
import { useGitStore } from '@/stores/gitStore'
import { useToastStore } from '@/stores/toastStore'
import type { UndoSnapshotMeta } from '@/types/git'

function snap(context = 'discard'): UndoSnapshotMeta {
  return { name: 'refs/polaris-undo/D:/repo/1', createdAt: 1, context, hasChanges: false, branch: 'main' }
}

describe('toastWithUndo', () => {
  const listFn = vi.fn()
  const restoreFn = vi.fn()
  const toastApi = {
    addToast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }

  beforeEach(() => {
    vi.resetAllMocks()
    useGitStore.setState({
      listUndoSnapshots: listFn,
      restoreUndoSnapshot: restoreFn,
      undoSnapshots: [],
      undoSnapshotsByWs: {},
    } as unknown as Partial<ReturnType<typeof useGitStore.getState>>)
    useToastStore.setState(toastApi as unknown as Partial<ReturnType<typeof useToastStore.getState>>)
  })

  it('有快照 → success toast 携撤销 action；点击恢复成功 → restored', async () => {
    listFn.mockImplementation(async (ws: string) => {
      useGitStore.setState({ undoSnapshots: [snap()], undoSnapshotsByWs: { [ws]: [snap()] } })
    })
    restoreFn.mockResolvedValue({ ok: true, conflictedFiles: [], conflictMessage: null })

    await toastWithUndo('D:/repo', '已丢弃')

    expect(toastApi.addToast).toHaveBeenCalledTimes(1)
    const arg = toastApi.addToast.mock.calls[0][0] as { action?: { label: string; onClick: () => Promise<void> } }
    expect(arg.action).toBeTruthy()
    await arg.action!.onClick()
    expect(restoreFn).toHaveBeenCalledWith('D:/repo', 'refs/polaris-undo/D:/repo/1')
    expect(toastApi.success).toHaveBeenCalledWith(expect.stringMatching(/restored|已恢复/))
  })

  it('无快照 → 普通 success toast（无 action）', async () => {
    await toastWithUndo('D:/repo', '普通成功')

    expect(toastApi.addToast).not.toHaveBeenCalled()
    expect(toastApi.success.mock.calls.length).toBeGreaterThan(0)
    expect(toastApi.success.mock.calls[0]?.[0]).toBe('普通成功')
  })

  it('恢复冲突 → warning 而非 success', async () => {
    listFn.mockImplementation(async (ws: string) => {
      useGitStore.setState({ undoSnapshots: [snap()], undoSnapshotsByWs: { [ws]: [snap()] } })
    })
    restoreFn.mockResolvedValue({ ok: true, conflictedFiles: ['a.ts', 'b.ts'], conflictMessage: 'conflict' })

    await toastWithUndo('D:/repo', '已丢弃')
    const arg = toastApi.addToast.mock.calls[0][0] as { action?: { onClick: () => Promise<void> } }
    await arg.action!.onClick()

    expect(toastApi.warning).toHaveBeenCalled()
    expect(toastApi.success).not.toHaveBeenCalled()
  })
})
