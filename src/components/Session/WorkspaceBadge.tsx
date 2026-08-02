/**
 * WorkspaceBadge - 工作区徽章组件
 * 
 * 显示在会话标签内的工作区指示器
 * - 无工作区时显示 "+" 图标
 * - 有工作区时显示工作区名称
 * - 有关联工作区时显示数量徽章
 */

import { memo, forwardRef } from 'react'
import { cn } from '@/utils/cn'
import { Folder, Plus } from 'lucide-react'

interface WorkspaceBadgeProps {
  workspaceId: string | null
  workspaceName?: string
  contextWorkspaceCount?: number
  onClick: (e: React.MouseEvent) => void
}

export const WorkspaceBadge = memo(
  forwardRef<HTMLButtonElement, WorkspaceBadgeProps>(function WorkspaceBadge(
    { workspaceId, workspaceName, contextWorkspaceCount = 0, onClick },
    ref
  ) {
    // 无工作区状态
    if (!workspaceId) {
      return (
        <button
          ref={ref}
          onClick={onClick}
          className={cn(
            'flex items-center gap-1 px-1.5 py-0.5 rounded text-xs',
            'bg-gray-500/20 text-gray-400',
            'hover:bg-gray-500/30 transition-colors',
            'shrink-0'
          )}
          title="选择工作区"
          aria-label="选择工作区"
        >
          <Plus className="w-3 h-3" />
        </button>
      )
    }

    // 有工作区状态
    return (
      <button
        ref={ref}
        onClick={onClick}
        className={cn(
          'flex items-center gap-1 px-1.5 py-0.5 rounded text-xs',
          'bg-blue-500/20 text-blue-400',
          'hover:bg-blue-500/30 transition-colors',
          'shrink-0 max-w-[120px]'
        )}
        title={`工作区: ${workspaceName || '未命名'}${contextWorkspaceCount > 0 ? ` (+${contextWorkspaceCount} 关联)` : ''}`}
        aria-label={`工作区: ${workspaceName || '未命名'}`}
      >
        <Folder className="w-3 h-3 shrink-0" />
        <span className="truncate">{workspaceName || '未命名'}</span>
        {contextWorkspaceCount > 0 && (
          <span className="px-1 bg-blue-500/40 rounded shrink-0">
            +{contextWorkspaceCount}
          </span>
        )}
      </button>
    )
  })
)
