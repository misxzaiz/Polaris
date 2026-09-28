/**
 * 内核注册中心 — 阶段 6：getKernel 单例访问（V2 后端权威，唯一实现）
 *
 * 职责：
 * - 懒初始化内核（首次访问时才动态 import 依赖）
 * - 提供 getKernel() / resetKernel()（测试用）
 *
 * 阶段 6：LegacySessionKernel 已彻底移除（文件删除），V2 是唯一实现。
 */

import type { SessionKernel } from './capabilities'
import type { V2SessionKernelDeps } from './v2-kernel'

let kernelPromise: Promise<SessionKernel> | null = null

/**
 * 获取会话内核单例（懒初始化）。
 *
 * 阶段 4+：返回 V2SessionKernel（后端权威）。
 * 阶段 6：唯一实现，无 Legacy 回退路径。
 */
export function getKernel(): Promise<SessionKernel> {
  if (!kernelPromise) {
    kernelPromise = createKernel()
  }
  return kernelPromise
}

/** 内部创建（分离以便测试注入） */
async function createKernel(): Promise<SessionKernel> {
  const { createV2SessionKernel } = await import('./v2-kernel')
  return createV2SessionKernel()
}

/**
 * 测试辅助：重置内核单例（下次 getKernel 重新创建）。
 * 也可传入 deps 覆盖依赖（测试注入替身）。
 */
export async function resetKernel(deps?: Partial<V2SessionKernelDeps>): Promise<void> {
  kernelPromise = null
  if (deps) {
    kernelPromise = createKernelWithDeps(deps)
  }
}

async function createKernelWithDeps(deps: Partial<V2SessionKernelDeps>): Promise<SessionKernel> {
  const { createV2SessionKernel } = await import('./v2-kernel')
  return createV2SessionKernel(deps)
}

// ============================================================================
// 命名空间导出
// ============================================================================

export type { SessionKernel } from './capabilities'
export type {
  MessageSendCapability,
  SessionLifecycleCapability,
  SessionHandle,
  StateQueryCapability,
  EventHandlingCapability,
  RecoveryCapability,
  ArbitrationCapability,
} from './capabilities'
