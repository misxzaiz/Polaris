/**
 * Diff 计算 Web Worker
 *
 * 将 computeDiff 移出主线程：大文件/大改动的行级 diff 可能耗时数百毫秒到数秒，
 * 在主线程同步执行会冻结 UI。本 Worker 接收 (oldContent, newContent)，返回完整 FileDiff。
 *
 * 通过 reqId 关联请求与响应，主线程据此丢弃过期结果（快速切换文件时）。
 */

import { computeDiff, type FileDiff } from './diffService'

export interface DiffWorkerRequest {
  reqId: number
  oldContent: string
  newContent: string
}

export type DiffWorkerResponse =
  | { reqId: number; diff: FileDiff }
  | { reqId: number; error: string }

// 避免引入 webworker lib（与 dom lib 的 self 类型冲突），用最小结构断言。
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<DiffWorkerRequest>) => void) | null
  postMessage: (message: DiffWorkerResponse) => void
}

ctx.onmessage = (event: MessageEvent<DiffWorkerRequest>) => {
  const { reqId, oldContent, newContent } = event.data
  try {
    const diff = computeDiff(oldContent, newContent)
    ctx.postMessage({ reqId, diff })
  } catch (err) {
    ctx.postMessage({ reqId, error: err instanceof Error ? err.message : String(err) })
  }
}
