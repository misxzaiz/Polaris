/**
 * 按仓库路径读取 Git 状态的 Hook
 *
 * 在多仓库/多 GitPanel 实例并存的场景下，全局 `status` 单例会被各路径的
 * 刷新互相覆盖（后完成的请求覆盖先完成的）。本 Hook 让组件按自己的
 * effectivePath 从 `statuses` 键控缓存中读取对应状态：
 * - effectivePath 非空：只订阅 `statuses[path]`，其它路径刷新不会触发重渲染
 * - effectivePath 为空：回退到全局 `status`（兼容非多仓库场景）
 */
import type { GitRepositoryStatus } from '@/types/git'
import { useGitStore } from '@/stores/gitStore/index'

export function useGitRepoStatus(
  workspacePath: string | undefined
): GitRepositoryStatus | null {
  const hasPath = !!workspacePath
  const path = workspacePath ?? ''
  return useGitStore((s) => (hasPath ? (s.statuses[path] ?? null) : s.status))
}