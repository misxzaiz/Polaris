/**
 * useKernelSessionState 适配层测试 — 阶段 4 批次 2
 *
 * 验证 8 个 isStreaming 消费方的共享数据源：
 * - useKernelSessionState：初始快照（本地兜底 → 后端权威）+ subscribe 更新 + 清理
 * - waitKernelSessionStreamEnd：running → idle 下降沿 resolve / 超时 reject
 * - kernelSessionIsStreaming：一次性后端查询
 *
 * 通过注入 FakeKernel（内存替身）隔离，不触碰真实 getKernel 单例。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { SessionState } from '../kernel/types'
import type { KernelSessionState } from '../hooks/useKernelSessionState'

// mock kernel 单例：返回可控 FakeKernel
const fakeKernel = {
  getSessionState: vi.fn<() => Promise<SessionState>>(),
  subscribe: vi.fn<() => () => void>(),
}
vi.mock('../kernel/registry', () => ({
  getKernel: vi.fn(async () => fakeKernel),
  resetKernel: vi.fn(),
  resetLegacyKernel: vi.fn(),
}))

import { useKernelSessionState, waitKernelSessionStreamEnd, kernelSessionIsStreaming } from '../hooks/useKernelSessionState'

function makeState(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionId: 's1',
    state: 'idle',
    isStreaming: false,
    lastEventSeq: 0,
    error: null,
    startedAt: null,
    endedAt: null,
    startedByDevice: null,
    ...overrides,
  }
}

/** 手动触发 FakeKernel.subscribe 注册的 handler */
let lastSubscribeHandler: ((next: SessionState, prev: SessionState) => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  lastSubscribeHandler = null
  fakeKernel.getSessionState.mockResolvedValue(makeState())
  fakeKernel.subscribe.mockImplementation((_sid: string, handler: (next: SessionState, prev: SessionState) => void) => {
    lastSubscribeHandler = handler
    return () => { lastSubscribeHandler = null }
  })
})

describe('useKernelSessionState', () => {
  it('初始：本地兜底 → 后端权威覆盖', async () => {
    fakeKernel.getSessionState.mockResolvedValue(makeState({ state: 'running', isStreaming: true }))
    const { result } = renderHook(() => useKernelSessionState('s1'))
    // 首帧：sessionId 就位（本地兜底 idle，后端异步未回）
    await waitFor(() => expect(result.current.state).toBe('running'))
    expect(result.current.isStreaming).toBe(true)
    expect(fakeKernel.getSessionState).toHaveBeenCalledWith('s1')
  })

  it('订阅后端状态变化 → 状态翻转', async () => {
    const { result } = renderHook(() => useKernelSessionState('s1'))
    await waitFor(() => expect(result.current.isStreaming).toBe(false))

    act(() => {
      lastSubscribeHandler?.(makeState({ state: 'running', isStreaming: true }), makeState())
    })
    expect(result.current.isStreaming).toBe(true)
    expect(result.current.state).toBe('running')

    act(() => {
      lastSubscribeHandler?.(makeState({ state: 'idle', isStreaming: false }), makeState({ state: 'running', isStreaming: true }))
    })
    expect(result.current.isStreaming).toBe(false)
  })

  it('后端查询失败 → 保持本地兜底（不抛错）', async () => {
    fakeKernel.getSessionState.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useKernelSessionState('s1'))
    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    // 订阅仍工作（后续后端恢复后能推状态）
    act(() => {
      lastSubscribeHandler?.(makeState({ state: 'running', isStreaming: true }), makeState())
    })
    expect(result.current.isStreaming).toBe(true)
  })

  it('sessionId 为 null → all-none', () => {
    const { result } = renderHook(() => useKernelSessionState(null))
    expect(result.current.sessionId).toBeNull()
    expect(result.current.state).toBe('none')
    expect(result.current.isStreaming).toBe(false)
  })

  it('卸载时取消订阅', async () => {
    const unsubSpy = vi.fn()
    fakeKernel.subscribe.mockImplementation((_sid, _handler) => {
      unsubSpy.mockImplementation(() => {})
      return unsubSpy
    })
    const { unmount } = renderHook(() => useKernelSessionState('s1'))
    await waitFor(() => expect(fakeKernel.subscribe).toHaveBeenCalled())
    unmount()
    expect(unsubSpy).toHaveBeenCalled()
  })
})

describe('waitKernelSessionStreamEnd', () => {
  it('已 idle → 立即 resolve', async () => {
    await expect(waitKernelSessionStreamEnd('s1')).resolves.toBeUndefined()
  })

  it('running → idle 下降沿 resolve', async () => {
    // 订阅前查询返回 running（保持等待）
    fakeKernel.getSessionState.mockResolvedValue(makeState({ state: 'running', isStreaming: true }))
    const p = waitKernelSessionStreamEnd('s1')
    // 等待 subscribeKernelSessionState 内部 getKernel().then 完成注册
    await waitFor(() => expect(lastSubscribeHandler).not.toBeNull())
    // 随后推送 running → idle
    act(() => {
      lastSubscribeHandler?.(makeState({ state: 'running', isStreaming: true }), makeState())
      lastSubscribeHandler?.(makeState({ state: 'idle', isStreaming: false }), makeState({ state: 'running', isStreaming: true }))
    })
    await expect(p).resolves.toBeUndefined()
  })

  it('超时 → reject timeout', async () => {
    // 订阅前查询返回 running（保持等待），随后无事件 → 超时 reject
    fakeKernel.getSessionState.mockResolvedValue(makeState({ state: 'running', isStreaming: true }))
    await expect(waitKernelSessionStreamEnd('s1', { timeoutMs: 50 })).rejects.toThrow('timeout')
  })

  it('AbortSignal 取消 → reject aborted', async () => {
    const controller = new AbortController()
    const p = waitKernelSessionStreamEnd('s1', { signal: controller.signal })
    controller.abort()
    await expect(p).rejects.toThrow('aborted')
  })
})

describe('kernelSessionIsStreaming', () => {
  it('后端 running → true', async () => {
    fakeKernel.getSessionState.mockResolvedValue(makeState({ state: 'running', isStreaming: true }))
    await expect(kernelSessionIsStreaming('s1')).resolves.toBe(true)
  })

  it('后端 idle → false', async () => {
    await expect(kernelSessionIsStreaming('s1')).resolves.toBe(false)
  })

  it('查询失败 → false（降级）', async () => {
    fakeKernel.getSessionState.mockRejectedValue(new Error('boom'))
    await expect(kernelSessionIsStreaming('s1')).resolves.toBe(false)
  })

  it('sessionId null → false', async () => {
    await expect(kernelSessionIsStreaming(null)).resolves.toBe(false)
  })
})