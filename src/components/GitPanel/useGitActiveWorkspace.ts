/**
 * Git 面板工作区 Hook
 *
 * Git 面板不再支持面板内切换工作区，始终与顶部（全局）当前工作区保持一致：
 * 直接跟随 workspaceStore 的 currentWorkspaceId，无面板级 activeWorkspaceId。
 */

import { useWorkspaceStore } from '@/stores/workspaceStore'

/**
 * 返回 Git 面板当前生效的工作区对象（或 null）。
 */
export function useGitActiveWorkspace() {
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId } = s
    return workspaces.find((w) => w.id === currentWorkspaceId) || null
  })
  return currentWorkspace
}