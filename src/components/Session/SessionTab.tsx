/**
 * SessionTab - 单个会话标签组件
 */

import { memo, useState, useRef } from 'react'
import { cn } from '@/utils/cn'
import { X, Loader2 } from 'lucide-react'
import { StatusDot } from './StatusDot'
import { WorkspaceBadge } from './WorkspaceBadge'
import { WorkspaceMenu } from './WorkspaceMenu'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { SessionMetadata } from '@/stores/conversationStore/types'
import type { SessionStatus } from '@/types/session'

interface SessionTabProps {
  session: SessionMetadata
  isActive: boolean
  onSelect: () => void
  onClose: () => void
  canClose: boolean
}

export const SessionTab = memo(function SessionTab({
  session,
  isActive,
  onSelect,
  onClose,
  canClose,
}: SessionTabProps) {
  const isRunning = session.status === 'running' || session.status === 'background-running'
  
  // 工作区菜单状态
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false)
  const badgeRef = useRef<HTMLButtonElement>(null)
  
  // 获取工作区信息
  const workspace = useWorkspaceStore(state => 
    session.workspaceId 
      ? state.workspaces.find(w => w.id === session.workspaceId)
      : null
  )
  
  // 获取关联工作区数量
  const contextCount = session.contextWorkspaceIds?.length || 0

  return (
    <>
      <div
        onClick={onSelect}
        className={cn(
          'group flex items-center gap-2 px-3 py-1.5 rounded-t-lg cursor-pointer',
          'border border-b-0 border-border transition-colors',
          'min-w-[100px] max-w-[200px]',
          isActive
            ? 'bg-background-elevated text-text-primary border-b-background-elevated'
            : 'bg-background-surface text-text-secondary hover:bg-background-hover'
        )}
        role="tab"
        aria-selected={isActive}
      >
        {/* 状态指示器 */}
        <StatusDot status={mapSessionStatus(session.status)} size="sm" />

        {/* 标题 - 占 70% */}
        <span className="flex-1 text-sm truncate min-w-0" title={session.title}>
          {session.title}
        </span>

        {/* 工作区徽章 - 占 20% */}
        <WorkspaceBadge
          ref={badgeRef}
          workspaceId={session.workspaceId}
          workspaceName={workspace?.name || session.workspaceName}
          contextWorkspaceCount={contextCount}
          onClick={(e) => {
            e.stopPropagation()
            setShowWorkspaceMenu(true)
          }}
        />

        {/* 运行中指示器 */}
        {isRunning && (
          <Loader2 className="w-3 h-3 text-primary animate-spin shrink-0" />
        )}

        {/* 关闭按钮 - 占 10% */}
        {canClose && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className={cn(
              'shrink-0 p-0.5 rounded',
              'text-text-muted hover:text-text-primary hover:bg-background-hover',
              'opacity-0 group-hover:opacity-100 transition-opacity'
            )}
            title="关闭会话"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* 工作区菜单弹窗 */}
      {showWorkspaceMenu && (
        <WorkspaceMenu
          sessionId={session.id}
          anchorEl={badgeRef.current}
          onClose={() => setShowWorkspaceMenu(false)}
        />
      )}
    </>
  )
})

/**
 * 映射会话状态到状态点状态
 */
function mapSessionStatus(
  status: SessionMetadata['status']
): SessionStatus {
  switch (status) {
    case 'running':
      return 'running'
    case 'waiting':
      return 'waiting'
    case 'error':
      return 'error'
    case 'background-running':
      return 'background-running'
    default:
      return 'idle'
  }
}