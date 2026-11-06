/**
 * kernel 会话状态适配层 — 阶段 4 批次 2
 *
 * 下游消费方（8 个 isStreaming 消费方）从直读 `store.isStreaming` 切换为
 * 订阅 V2SessionKernel 的后端权威状态，中间统一走本适配层：
 *
 * - `useKernelSessionState(sessionId)`：React hook，内部 `getSessionState` + `subscribe`，
 *   返回 `{ state, isStreaming, error, sessionId }`（消费方 1/2 及 commitMessageChat 等 UI 侧使用）
 * - `waitKernelSessionStreamEnd(sessionId, opts?)`：非 React 服务侧等待「running → idle/error」
 *   下降沿，等价于旧 `sawStreaming + subscribe` 完成检测（消费方 3-6 使用）
 * - `kernelSessionIsStreaming(sessionId)`：一次性查询后端状态，返回 isStreaming
 *   （消费方 7/8 的一次性检查使用）
 *
 * 降级策略：内核查询链路异常时（会话不存在 / 后端不可用），静默退化到 store
 * 本地快照（仅兜底，不作为状态源），保证消费方平稳运行。
 */

import { useEffect, useState } from 'react'
import { getKernel } from '../kernel/registry'
import type { SessionState } from '../kernel/types'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'

// ============================================================================
// 类型
// ============================================================================

export interface KernelSessionState {
  sessionId: string | null
  /** 后端权威运行时状态：running / idle / error / none */
  state: SessionState['state']
  /** 是否正在流式输出（state === 'running' 的投影） */
  isStreaming: boolean
  error: string | null
}

const EMPTY_STATE: KernelSessionState = {
  sessionId: null,
  state: 'none',
  isStreaming: false,
  error: null,
}

/** 取当前消费方关心的后端状态；不可用时降级 store 本地快照（仅兜底） */
export function getKernelSessionStateSnapshot(sessionId: string | null): KernelSessionState {
  return { ...EMPTY_STATE, sessionId }
}

/** 订阅 kernel：内部已做降级，handler 收到的是推导后的 KernelSessionState */
export function subscribeKernelSessionState(
  sessionId: string,
  onChange: (state: KernelSessionState) => void,
): () => void {
  let disposed = false
  let unsubKernel: (() => void) | null = null

  const emit = (state: KernelSessionState) => {
    if (!disposed) onChange(state)
  }

  // 订阅 kernel 后端状态
  void getKernel().then((kernel) => {
    if (disposed) return
    unsubKernel = kernel.subscribe(sessionId, (next) => {
      emit({
        sessionId,
        state: next.state,
        isStreaming: next.state === 'running',
        error: next.error,
      })
    })
  })

  return () => {
    disposed = true
    unsubKernel?.()
  }
}

/**
 * 等待指定会话流式结束（running → idle/error 下降沿）。
 * 等价旧 `sawStreaming + store.subscribe` 完成检测，但状态源为内核后端权威。
 *
 * 语义：
 * - 若当前已 idle → resolve（空 Promise）
 * - 若在等待期间发生 error 且从未进入 running → resolve（失败由调用方凭 error 判断）
 * - 可选 timeout：超时后中断会话并 reject（对齐消费方既有超时兜底）
 * - 支持 AbortSignal 取消（文档阶段 4 O2）
 *
 * requireRunEvidence（2026-11-06，压缩交接空窗竞态修复）：
 * - 空窗问题：调用方刚 dispatch 完 sendMessage（引擎已 spawn）但引擎尚未产出
 *   首个事件——后端 lifecycle 事件日志尚空（session_start 由首事件补写，
 *   ai_chat_core.rs），此时查询得 idle 并非「已结束」，而是「尚未开始」。
 *   默认语义在此窗口提前 resolve，调用方（压缩交接）拿空消息报
 *   「压缩引擎未产出简报内容」并把刚起步的运行掐死。
 * - 开启后：必须先观测到 running（订阅推送或一次性查询任一来源），
 *   此后才认 idle/error 下降沿；从未观测到 running 则保持等待，由 timeout 兜底。
 * - 默认关闭，既有消费方（radioBroadcastController 等）行为零变更。
 */
export function waitKernelSessionStreamEnd(
  sessionId: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal; requireRunEvidence?: boolean },
): Promise<void> {
  const { timeoutMs, signal, requireRunEvidence = false } = opts ?? {}

  return new Promise<void>((resolve, reject) => {
    const cleanupFns: Array<() => void> = []
    let settled = false
    let sawRunning = false
    let unsubscribe: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      cleanupFns.forEach((fn) => {
        try { fn() } catch { /* noop */ }
      })
      cleanupFns.length = 0
    }

    const onAbort = () => {
      if (settled) return
      cleanup()
      reject(new Error('aborted'))
    }

    const settleIdle = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    /** 状态到达：requireRunEvidence 门控下，running 只记账不收尾 */
    const onState = (state: KernelSessionState) => {
      if (state.state === 'running') {
        sawRunning = true
        return
      }
      // 已离开 running（idle 或 error 都算结束）；
      // requireRunEvidence 下，running 之前的 idle/error 处于「引擎尚未产出
      // 首事件」空窗，不收尾（timeout 兜底），running 之后的才认下降沿。
      if (requireRunEvidence && !sawRunning) return
      settleIdle()
    }

    // 订阅 kernel 状态（running → idle/error 即流式结束）
    unsubscribe = subscribeKernelSessionState(sessionId, onState)
    cleanupFns.push(() => unsubscribe?.())

    if (timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error('timeout'))
      }, timeoutMs)
      cleanupFns.push(() => { if (timer) clearTimeout(timer) })
    }

    signal?.addEventListener('abort', onAbort)
    cleanupFns.push(() => { signal?.removeEventListener('abort', onAbort) })

    // 订阅建立前可能已 idle（会话从未运行 / 已结束）：查询当前状态兜底，
    // 避免只靠事件驱动而永久挂起（对齐旧 waitForIdle 的竞态兜底语义）。
    // requireRunEvidence 下同样遵守门控：查询得 running 记账、非 running 不收尾。
    void kernelSessionIsStreaming(sessionId).then((streaming) => {
      if (settled) return
      if (streaming) {
        sawRunning = true
      } else if (!requireRunEvidence) {
        settleIdle()
      }
    }).catch(() => { /* 查询失败：保持订阅等待事件 */ })
  })
}

/** 一次性查询后端状态 → isStreaming（消费方 7/8 检查用） */
export async function kernelSessionIsStreaming(sessionId: string | null): Promise<boolean> {
  if (!sessionId) return false
  try {
    const kernel = await getKernel()
    const state = await kernel.getSessionState(sessionId)
    return state.state === 'running' || state.isStreaming
  } catch {
    return false
  }
}

/**
 * React hook：订阅内核后端状态。
 * 返回 { state, isStreaming, error, sessionId }；sessionId 为空时返回 all-none。
 * 内部 getSessionState + subscribe，自动清理订阅。
 * 初值先用 store 本地快照兜底（避免后端异步查询首帧闪变），随后以内核后端状态为准。
 */
export function useKernelSessionState(sessionId: string | null): KernelSessionState {
  const [state, setState] = useState<KernelSessionState>(() => getKernelSessionStateSnapshot(sessionId))

  // 初始快照（一次性查询后端；查前先用本地快照兜底，查后覆盖）
  useEffect(() => {
    if (!sessionId) {
      setState(getKernelSessionStateSnapshot(null))
      return
    }
    // 本地快照初值（渲染首帧不闪变；本地渲染投影，仅兜底，不作为跨设备状态源）
    const localStore = sessionStoreManager.getState().stores.get(sessionId)
    const localStreaming = localStore?.getState().isStreaming ?? false
    const localError = localStore?.getState().error ?? null
    setState({
      sessionId,
      state: localStreaming ? 'running' : localError ? 'error' : 'idle',
      isStreaming: localStreaming,
      error: localError,
    })

    let disposed = false
    void getKernel().then(async (kernel) => {
      if (disposed) return
      try {
        const s = await kernel.getSessionState(sessionId)
        if (disposed) return
        setState({
          sessionId,
          state: s.state,
          isStreaming: s.state === 'running',
          error: s.error,
        })
      } catch {
        if (disposed) return
        // 查询失败：维持本地快照（仅兜底，不作为状态源）
      }
    })
    return () => { disposed = true }
  }, [sessionId])

  // 订阅后端状态变化
  useEffect(() => {
    if (!sessionId) return
    return subscribeKernelSessionState(sessionId, (next) => setState(next))
  }, [sessionId])

  return state
}