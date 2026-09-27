/**
 * 内核注册中心 — 阶段 3：getKernel 单例访问
 *
 * 职责：
 * - 懒初始化 LegacySessionKernel（首次访问时才动态 import 依赖，影子运行不主动初始化）
 * - 提供 getKernel() / resetKernel()（测试用）
 * - 后续阶段（4）V2SessionKernel 就绪后，在此切换实现，消费方无需改 import
 */

import type { SessionKernel } from './capabilities'
import type { LegacySessionKernelDeps } from './legacy-kernel'

let kernelPromise: Promise<SessionKernel> | null = null

/**
 * 获取会话内核单例（懒初始化）。
 *
 * 阶段 3：返回 LegacySessionKernel（桥接现有路径，行为零变化）。
 * 阶段 4：切换为 V2SessionKernel（后端权威）。
 */
export function getKernel(): Promise<SessionKernel> {
  if (!kernelPromise) {
    kernelPromise = createKernel()
  }
  return kernelPromise
}

/** 内部创建（分离以便测试注入） */
async function createKernel(): Promise<SessionKernel> {
  const { createLegacySessionKernel } = await import('./legacy-kernel')
  return createLegacySessionKernel()
}

/**
 * 测试辅助：重置内核单例（下次 getKernel 重新创建）。
 * 也可传入 deps 覆盖依赖（影子测试注入替身）。
 */
export async function resetKernel(deps?: Partial<LegacySessionKernelDeps>): Promise<void> {
  kernelPromise = null
  if (deps) {
    kernelPromise = createKernelWithDeps(deps)
  }
}

async function createKernelWithDeps(deps: Partial<LegacySessionKernelDeps>): Promise<SessionKernel> {
  const { createLegacySessionKernel } = await import('./legacy-kernel')
  return createLegacySessionKernel(deps)
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
