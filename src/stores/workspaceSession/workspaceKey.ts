/**
 * workspaceKey 解析（S2 · 对齐 ZCode resolveWorkspaceStateKey）
 *
 * 规则（spec §4.1）：
 * - identity 非空 → 用 identity（远程/容器/WSL 等身份隔离）
 * - identity 为空 → 回退 path（本地场景）
 *
 * 状态写入只写 identity 桶；path 桶仅作本地 fallback 和迁移起点，
 * 防远程串台（对齐 zcodeSessionStoreSelectors.updateWorkspaceState 注释纪律）。
 */

import { FREE_WORKSPACE_KEY, type ResolveWorkspaceKeyParams } from './types'

/**
 * 解析 workspaceKey。
 *
 * @param params.path 工作区路径（必填，本地稳定标识）
 * @param params.identity 工作区身份标识（远程/容器场景；本地为空）
 * @returns workspaceKey（identity ?? path），两者皆空返回 FREE_WORKSPACE_KEY
 */
export function resolveWorkspaceKey(params: ResolveWorkspaceKeyParams): string {
  const identity = params.identity?.trim()
  if (identity) return identity
  const path = params.path?.trim()
  if (path) return path
  return FREE_WORKSPACE_KEY
}

/**
 * 解析 workspaceKey（字符串重载，path-only 场景）。
 *
 * 等价于 resolveWorkspaceKey({ path })，用于只需 path 的调用点。
 */
export function resolveWorkspaceKeyFromPath(path: string | null | undefined): string {
  const trimmed = path?.trim()
  if (trimmed) return trimmed
  return FREE_WORKSPACE_KEY
}

/**
 * 判断该 key 是否为 free 桶（无工作区）。
 */
export function isFreeWorkspaceKey(key: string): boolean {
  return key === FREE_WORKSPACE_KEY
}
