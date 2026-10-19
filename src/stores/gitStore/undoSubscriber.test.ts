/**
 * FR-P2-3 · undoSubscriber 单元测试
 *
 * 验收（spec §三）：
 * - 事件到达 → 弹出「撤销」toast（含 action 按钮）
 * - 点击撤销 → restoreUndoSnapshot(wsPath, snapshotRef)，成功 toast.success
 * - 恢复遇冲突（outcome.ok=false）→ toast.error 展示 conflictedFiles
 * - 恢复抛错 → toast.error
 * - 载荷缺 wsPath/snapshotRef → 跳过不弹 toast
 * - cleanup 取消监听；cleanup 后事件不再弹 toast
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- mocks ---
const mockListen = vi.fn()
vi.mock('@/services/transport', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

const mockAddToast = vi.fn()
const mockSuccess = vi.fn()
const mockError = vi.fn()
vi.mock('@/stores/toastStore', () => ({
  useToastStore: {
    getState: () => ({
      addToast: mockAddToast,
      success: mockSuccess,
      error: mockError,
    }),
  },
}))

const mockRestore = vi.fn()
vi.mock('@/stores/gitStore', () => ({
  useGitStore: {
    getState: () => ({
      restoreUndoSnapshot: mockRestore,
    }),
  },
}))

// Import after mocking
import { initUndoToastSubscriber } from './undoSubscriber'
import type { UndoSnapshotEvent } from '@/types/git'

function captureHandler() {
  const listenArgs = mockListen.mock.calls[0]!
  return listenArgs[1] as (e: UndoSnapshotEvent) => void
}

/** 触发 toast action 的 onClick（捕获 addToast 的第一个参数） */
function captureToastAction() {
  const toastArgs = mockAddToast.mock.calls[0]!
  const toast = toastArgs[0] as { action?: { onClick: () => void } }
  return toast.action?.onClick
}

/** flush 微任务（让 onClick 内的 then/catch 链结算） */
async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('undoSubscriber (FR-P2-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListen.mockResolvedValue(() => {})
    mockAddToast.mockImplementation(() => 'toast-1')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('事件到达 → 弹出含「撤销」action 的 toast', () => {
    initUndoToastSubscriber()
    const handler = captureHandler()

    handler({ wsPath: 'C:/repo', snapshotRef: 'refs/polaris-undo/C:_repo/1700000000', context: 'discard' })

    expect(mockAddToast).toHaveBeenCalledTimes(1)
    const toast = mockAddToast.mock.calls[0]![0]
    expect(toast.type).toBe('info')
    expect(toast.duration).toBe(20000)
    expect(toast.action.label).toBe('撤销')
    // branch_delete 文案区分
    expect(toast.title).toContain('丢弃变更')
  })

  it('点击「撤销」→ 调用 restoreUndoSnapshot，成功 toast.success', async () => {
    initUndoToastSubscriber()
    const handler = captureHandler()
    mockRestore.mockResolvedValueOnce({ ok: true, conflictedFiles: [], conflictMessage: null })

    handler({ wsPath: 'C:/repo', snapshotRef: 'refs/undo/1', context: 'reset_hard' })
    const onClick = captureToastAction()!
    await onClick()
    await flush()

    expect(mockRestore).toHaveBeenCalledWith('C:/repo', 'refs/undo/1')
    expect(mockSuccess).toHaveBeenCalledWith('撤销成功', '已恢复到操作前状态')
  })

  it('恢复遇冲突（ok=false）→ toast.error 展示 conflictedFiles', async () => {
    initUndoToastSubscriber()
    const handler = captureHandler()
    mockRestore.mockResolvedValueOnce({
      ok: false,
      conflictedFiles: ['src/a.ts', 'src/b.ts'],
      conflictMessage: 'Merge conflict in src/a.ts',
    })

    handler({ wsPath: 'C:/repo', snapshotRef: 'refs/undo/2', context: 'checkout' })
    const onClick = captureToastAction()!
    await onClick()
    await flush()

    expect(mockError).toHaveBeenCalledWith('撤销遇到冲突', 'Merge conflict in src/a.ts')
  })

  it('恢复抛错 → toast.error', async () => {
    initUndoToastSubscriber()
    const handler = captureHandler()
    mockRestore.mockRejectedValueOnce(new Error('git: apply failed'))

    handler({ wsPath: 'C:/repo', snapshotRef: 'refs/undo/3', context: 'rebase' })
    const onClick = captureToastAction()!
    await onClick()
    await flush()

    expect(mockError).toHaveBeenCalledWith('撤销失败', 'git: apply failed')
  })

  it('载荷缺 wsPath/snapshotRef → 跳过不弹 toast', () => {
    initUndoToastSubscriber()
    const handler = captureHandler()

    handler({ wsPath: '', snapshotRef: 'refs/undo/1', context: 'discard' })
    expect(mockAddToast).not.toHaveBeenCalled()

    handler({ wsPath: 'C:/repo', snapshotRef: '', context: 'discard' })
    expect(mockAddToast).not.toHaveBeenCalled()
  })

  it('cleanup 取消监听；cleanup 后事件不再弹 toast', async () => {
    const cleanup = initUndoToastSubscriber()
    const handler = captureHandler()
    expect(mockListen.mock.calls[0]![0]).toBe('git-undo-snapshot')

    cleanup()
    handler({ wsPath: 'C:/repo', snapshotRef: 'refs/undo/4', context: 'discard' })
    expect(mockAddToast).not.toHaveBeenCalled()
  })
})
