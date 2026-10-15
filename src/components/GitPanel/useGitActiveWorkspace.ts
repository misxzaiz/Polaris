/**
 * Git 面板独立工作区 Hook
 *
 * Git 面板通过顶部下拉可切换自己关注的工作区（activeWorkspaceId，仅内存态），
 * 此指针只影响 Git 面板及其子组件，不影响 FileExplorer 等读取共享
 * viewingWorkspaceId 的全局组件，也不写回 currentWorkspaceId。
 *
 * 取值优先级：
 * 1. activeWorkspaceId（Git 面板下拉显式选择）
 * 2. currentWorkspaceId（全局当前工作区，跟随其切换）
 *
 * 跟随规则：
 * - 当全局 currentWorkspaceId 变化（工作区切换器/其他全局入口切换）时，
 *   自动清除面板级 activeWorkspaceId，让 Git 面板跟随全局。
 * - Git 面板内下拉切换只写 activeWorkspaceId，不影响全局与 FileExplorer。
 *
 * 注意：不跟随 FileExplorer 的 viewingWorkspaceId —— 这是 Git 面板独立
 * 工作区语义的核心（在文件浏览器里临时浏览其他目录不应联动 Git 面板）。
 */

import { useEffect } from 'react'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useGitStore } from '@/stores/gitStore/index'

/**
 * 返回 Git 面板当前生效的工作区对象（或 null）。
 */
export function useGitActiveWorkspace() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId)
  const activeWorkspaceId = useGitStore((s) => s.activeWorkspaceId)
  const setActiveWorkspaceId = useGitStore((s) => s.setActiveWorkspaceId)

  // 全局工作区切换时跟随：清除面板级指针，回落到 currentWorkspaceId
  useEffect(() => {
    setActiveWorkspaceId(null)
  }, [currentWorkspaceId, setActiveWorkspaceId])

  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces } = s
    const targetId = activeWorkspaceId ?? currentWorkspaceId
    return workspaces.find((w) => w.id === targetId) || null
  })
  return currentWorkspace
}