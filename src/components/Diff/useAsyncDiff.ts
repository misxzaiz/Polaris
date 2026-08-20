/**
 * 异步 Diff 计算 Hook
 *
 * 分流策略：
 * - 小内容（总字符数 ≤ 阈值）：主线程同步计算。首屏即出结果、无 loading 闪烁，
 *   且不触碰 Worker（保证 jsdom 测试环境与 SSR 安全）。
 * - 大内容：交给共享 Web Worker 异步计算，主线程不阻塞；通过 reqId 丢弃过期结果。
 * - 无 Worker 环境：兜底为「让出一帧 → 主线程计算」。
 */

import { useState, useEffect, useRef } from 'react'
import { computeDiff, type FileDiff } from '@/services/diffService'
import type { DiffWorkerRequest, DiffWorkerResponse } from '@/services/diffWorker'

/** 内容总字符数超过该阈值改用 Worker 异步计算（约 50KB 文本，主线程同步通常 < 15ms） */
const ASYNC_CHAR_THRESHOLD = 50_000

const EMPTY_DIFF: FileDiff = {
  oldContent: '',
  newContent: '',
  lines: [],
  addedCount: 0,
  removedCount: 0,
}

// 模块级共享 Worker（多个 DiffViewer 复用，靠 reqId 路由）
let sharedWorker: Worker | null = null
let workerUnavailable = false

function getWorker(): Worker | null {
  if (workerUnavailable) return null
  if (typeof Worker === 'undefined') {
    workerUnavailable = true
    return null
  }
  if (!sharedWorker) {
    try {
      sharedWorker = new Worker(new URL('../../services/diffWorker.ts', import.meta.url), { type: 'module' })
    } catch {
      workerUnavailable = true
      return null
    }
  }
  return sharedWorker
}

let reqCounter = 0

export interface AsyncDiffState {
  diff: FileDiff
  loading: boolean
}

export function useAsyncDiff(oldContent: string, newContent: string): AsyncDiffState {
  const isSmall = oldContent.length + newContent.length <= ASYNC_CHAR_THRESHOLD

  // 小内容首屏同步算出；大内容初始为 loading
  const [state, setState] = useState<AsyncDiffState>(() =>
    isSmall
      ? { diff: computeDiff(oldContent, newContent), loading: false }
      : { diff: EMPTY_DIFF, loading: true },
  )
  const activeReq = useRef(0)

  useEffect(() => {
    if (isSmall) {
      setState({ diff: computeDiff(oldContent, newContent), loading: false })
      return
    }

    const worker = getWorker()
    if (!worker) {
      // 无 Worker 环境兜底：先显示 loading，再让出一帧后同步计算
      setState((s) => ({ ...s, loading: true }))
      const handle = setTimeout(() => {
        setState({ diff: computeDiff(oldContent, newContent), loading: false })
      }, 0)
      return () => clearTimeout(handle)
    }

    const reqId = ++reqCounter
    activeReq.current = reqId
    setState((s) => ({ ...s, loading: true }))

    const onMessage = (event: MessageEvent<DiffWorkerResponse>) => {
      if (event.data.reqId !== reqId) return
      worker.removeEventListener('message', onMessage)
      if (activeReq.current !== reqId) return // 已被更晚的请求取代
      if ('error' in event.data) {
        setState({ diff: computeDiff(oldContent, newContent), loading: false }) // 兜底
      } else {
        setState({ diff: event.data.diff, loading: false })
      }
    }

    worker.addEventListener('message', onMessage)
    const request: DiffWorkerRequest = { reqId, oldContent, newContent }
    worker.postMessage(request)

    return () => {
      worker.removeEventListener('message', onMessage)
      if (activeReq.current === reqId) activeReq.current = 0
    }
  }, [oldContent, newContent, isSmall])

  return state
}
