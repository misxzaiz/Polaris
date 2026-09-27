/**
 * 内核注册中心 — 阶段 5：getKernel 单例访问（V2 后端权威）
 *
 * 职责：
 * - 懒初始化内核（首次访问时才动态 import 依赖）
 * - 提供 getKernel() / resetKernel()（测试用）
 * - 阶段 2 起默认实现为 V2SessionKernel（后端权威状态查询）；
 *   Legacy 实现保留为 `getLegacyKernel()` 供阶段 3 影子对比测试——已停用，
 *   仅测试契约与渐进回退参考，生产路径不再创建（@deprecated）。
 */

import type { SessionKernel } from './capabilities'
import type { LegacySessionKernelDeps } from './legacy-kernel'
import type { V2SessionKernelDeps } from './v2-kernel'

let kernelPromise: Promise<SessionKernel> | null = null

/**
 * 获取会话内核单例（懒初始化）。
 *
 * 阶段 4+：返回 V2SessionKernel（后端权威）。
 * 生产路径唯一入口；Legacy 已退役（见 getLegacyKernel 的 @deprecated）。
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
export async function resetKernel(deps?: Partial<LegacySessionKernelDeps> | Partial<V2SessionKernelDeps>): Promise<void> {
  kernelPromise = null
  if (deps) {
    kernelPromise = createKernelWithDeps(deps)
  }
}

async function createKernelWithDeps(deps: Partial<LegacySessionKernelDeps> | Partial<V2SessionKernelDeps>): Promise<SessionKernel> {
  const { createV2SessionKernel } = await import('./v2-kernel')
  return createV2SessionKernel(deps as Partial<V2SessionKernelDeps>)
}

// ============================================================================
// Legacy 内核（阶段 3 影子对比测试用，已退役）
// ============================================================================

let legacyKernelPromise: Promise<SessionKernel> | null = null

/**
 * @deprecated 阶段 5：LegacySessionKernel 已退役。生产路径一律走 getKernel()（V2）。
 * 本入口仅供 case-3b 影子对比测试与渐进回退参考；新代码不得调用。
 */
export function getLegacyKernel(): Promise<SessionKernel> {
  if (!legacyKernelPromise) {
    legacyKernelPromise = (async () => {
      const { createLegacySessionKernel } = await import('./legacy-kernel')
      return createLegacySessionKernel()
    })()
  }
  return legacyKernelPromise
}

/** 测试辅助：重置 Legacy 内核单例（@deprecated，理由同上） */
export function resetLegacyKernel(): void {
  legacyKernelPromise = null
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
