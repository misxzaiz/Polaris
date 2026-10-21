/**
 * FR-P2-2 · fileWatcherSubscriber 单元测试
 *
 * 验收（spec §三）：
 * - 事件到达且未流式 → debounce 800ms 后 refreshStatus
 * - 事件到达且流式中 → 不刷，置「待补刷」
 * - 流式下降沿到达且「待补刷」置位 → 立即 refreshStatus
 * - getEffectivePath() 返回 null → 不刷
 * - cleanup 取消订阅、清防抖 timer 与待补刷；cleanup 后事件不再刷
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- mocks ---
const mockListen = vi.fn()
vi.mock('@/services/transport', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

const mockKernelStreaming = vi.fn()
const mockSubscribeKernel = vi.fn()
vi.mock('@/session-v2/hooks/useKernelSessionState', () => ({
  kernelSessionIsStreaming: (...args: unknown[]) => mockKernelStreaming(...args),
  subscribeKernelSessionState: (...args: unknown[]) => mockSubscribeKernel(...args),
}))

const mockGetState = vi.fn()
vi.mock('@/stores/conversationStore/sessionStoreManager', () => ({
  sessionStoreManager: {
    getState: () => mockGetState(),
  },
}))

const mockRefreshStatus = vi.fn()
const mockRefreshStatusDebounced = vi.fn()
/** gitStore.getState() 的可变镜像（C9 用例会改 sequenceActivityUntilByWs） */
const mockGitState: {
  refreshStatus: typeof mockRefreshStatus
  refreshStatusDebounced: typeof mockRefreshStatusDebounced
  sequenceActivityUntilByWs?: Record<string, number>
} = {
  refreshStatus: mockRefreshStatus,
  refreshStatusDebounced: mockRefreshStatusDebounced,
}
vi.mock('@/stores/gitStore', () => ({
  useGitStore: {
    getState: () => mockGitState,
  },
}))

// Import after mocking
import { initGitStatusWatcher } from './fileWatcherSubscriber'
import type { FsChangeEvent } from '@/types'

function captureHandler() {
  const listenArgs = mockListen.mock.calls[0]!
  return listenArgs[1] as (e: FsChangeEvent) => void
}

function emitEvent(handler: (e: FsChangeEvent) => void, affectedDirs: string[]) {
  handler({ affectedDirs })
}

/** flush microtask（让 kernelSessionIsStreaming.then 结算） */
async function flushMicrotasks() {
  // resolve 一个已 settled 的 promise 两次，让 promise 链走完
  await Promise.resolve()
  await Promise.resolve()
}

const debounceMs = 800

describe('fileWatcherSubscriber (FR-P2-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockKernelStreaming.mockResolvedValue(false)
    mockGetState.mockReturnValue({ activeSessionId: null })
    mockRefreshStatus.mockResolvedValue(undefined)
    mockRefreshStatusDebounced.mockResolvedValue(undefined)
    mockListen.mockResolvedValue(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('事件到达且未流式 → debounce 到期后 refreshStatus', async () => {
    const cleanup = initGitStatusWatcher(() => '/repo')
    const handler = captureHandler()

    emitEvent(handler, ['src'])
    await flushMicrotasks()

    // 800ms 未到：不调 refreshStatus
    await vi.advanceTimersByTimeAsync(debounceMs - 1)
    expect(mockRefreshStatus).not.toHaveBeenCalled()

    // debounce 到期：调 refreshStatus 一次
    await vi.advanceTimersByTimeAsync(1)
    expect(mockRefreshStatus).toHaveBeenCalledTimes(1)
    expect(mockRefreshStatus).toHaveBeenCalledWith('/repo')

    cleanup()
  })

  it('事件到达且流式中 → 不刷，置待补刷；下降沿到达 → 立即 refreshStatus', async () => {
    mockKernelStreaming.mockResolvedValue(true)
    const cleanup = initGitStatusWatcher(() => '/repo')
    const handler = captureHandler()

    // 流式中事件到达
    emitEvent(handler, ['src'])
    await flushMicrotasks()
    expect(mockRefreshStatus).not.toHaveBeenCalled()
    expect(mockRefreshStatusDebounced).not.toHaveBeenCalled()

    // activeSessionId 为 null 时不下发 kernel 订阅
    expect(mockSubscribeKernel).not.toHaveBeenCalled()

    // 切换到有活动会话，触发 ensureStreamingSubscription → 订阅
    mockGetState.mockReturnValue({ activeSessionId: 'sess-1' })
    emitEvent(handler, ['lib'])
    await flushMicrotasks()
    expect(mockSubscribeKernel).toHaveBeenCalledWith('sess-1', expect.any(Function))

    // 模拟流式结束下降沿
    const onKernelState = mockSubscribeKernel.mock.calls[0]![1] as (s: { isStreaming: boolean }) => void
    onKernelState({ isStreaming: false })

    // 下降沿补刷：立即 refreshStatus，不走 debounce
    expect(mockRefreshStatus).toHaveBeenCalledTimes(1)
    expect(mockRefreshStatusDebounced).not.toHaveBeenCalled()

    cleanup()
  })

  it('getEffectivePath() 返回 null → 事件到达不刷', async () => {
    const cleanup = initGitStatusWatcher(() => null)
    const handler = captureHandler()

    emitEvent(handler, ['src'])
    await flushMicrotasks()

    expect(mockKernelStreaming).not.toHaveBeenCalled()
    expect(mockRefreshStatus).not.toHaveBeenCalled()

    cleanup()
  })

  it('防抖窗口内多次事件合并为一次刷新', async () => {
    const cleanup = initGitStatusWatcher(() => '/repo')
    const handler = captureHandler()

    emitEvent(handler, ['src'])
    await flushMicrotasks()
    emitEvent(handler, ['lib'])
    await flushMicrotasks()

    // 未到 debounce 时间
    await vi.advanceTimersByTimeAsync(debounceMs - 1)
    expect(mockRefreshStatus).not.toHaveBeenCalled()

    // 时间越过：只刷一次（后一次事件重置了 timer）
    await vi.advanceTimersByTimeAsync(1)
    expect(mockRefreshStatus).toHaveBeenCalledTimes(1)

    cleanup()
  })

  it('cleanup 取消监听并清防抖 timer；cleanup 后事件不再刷', async () => {
    const unlistenFn = vi.fn()
    mockListen.mockResolvedValue(unlistenFn)
    const cleanup = initGitStatusWatcher(() => '/repo')
    const handler = captureHandler()

    emitEvent(handler, ['src'])
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(debounceMs)
    expect(mockRefreshStatus).toHaveBeenCalledTimes(1)

    cleanup()
    expect(unlistenFn).toHaveBeenCalled()

    // cleanup 后事件不再刷
    emitEvent(handler, ['lib'])
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(debounceMs)
    expect(mockRefreshStatus).toHaveBeenCalledTimes(1)
  })

  it('C9 序列操作活动窗口内 → 防抖放宽到 3000ms；窗口过后恢复 800ms', async () => {
    const cleanup = initGitStatusWatcher(() => '/repo')
    const handler = captureHandler()

    // 进入活动窗口（until 在未来 10s）
    mockGitState.sequenceActivityUntilByWs = { '/repo': Date.now() + 10_000 }
    emitEvent(handler, ['src'])
    await flushMicrotasks()

    // 常规 800ms 窗口内不刷（放宽中）
    await vi.advanceTimersByTimeAsync(debounceMs - 1)
    expect(mockRefreshStatus).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mockRefreshStatus).not.toHaveBeenCalled()

    // 3s 窗口到期 → 刷一次
    await vi.advanceTimersByTimeAsync(3000 - debounceMs)
    expect(mockRefreshStatus).toHaveBeenCalledTimes(1)

    // 窗口过后 → 恢复常规 800ms
    mockGitState.sequenceActivityUntilByWs = {}
    emitEvent(handler, ['more'])
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(debounceMs - 1)
    expect(mockRefreshStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mockRefreshStatus).toHaveBeenCalledTimes(2)

    cleanup()
  })
})