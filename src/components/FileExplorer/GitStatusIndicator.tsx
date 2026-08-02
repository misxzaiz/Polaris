/**
 * Git 状态指示器组件
 *
 * 在 FileExplorer 工具栏显示 Git 分支和变更状态
 */

import { GitBranch } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useViewStore } from '@/stores'

export function GitStatusIndicator() {
  const { status } = useGitStore()
  const { toggleGitPanel } = useViewStore()

  if (!status || !status.branch) {
    return null
  }

  const totalChanges = status.staged.length + status.unstaged.length + status.untracked.length

  return (
    <button
      onClick={() => toggleGitPanel()}
      className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs bg-background-surface hover:bg-background-hover transition-colors group cursor-pointer"
      title={`分支: ${status.branch}${totalChanges > 0 ? `\n未提交变更: ${totalChanges}` : ''}`}
    >
      <GitBranch size={12} className="text-text-tertiary" />
      <span className="text-text-secondary font-medium">{status.branch}</span>

      {totalChanges > 0 && (
        <span className="flex items-center justify-center w-4 h-4 text-xs bg-warning/20 text-warning rounded-full">
          {totalChanges}
        </span>
      )}

      {status.ahead > 0 && (
        <span className="text-success text-xs" title={`领先 ${status.ahead} 个提交`}>
          ↑{status.ahead}
        </span>
      )}

      {status.behind > 0 && (
        <span className="text-warning text-xs" title={`落后 ${status.behind} 个提交`}>
          ↓{status.behind}
        </span>
      )}
    </button>
  )
}
