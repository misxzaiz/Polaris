/**
 * SessionIsland - 会话悬浮岛组件
 *
 * 位于 RightPanel 顶部，用于：
 * 1. 显示当前会话状态和标题
 * 2. 切换会话和工作区
 * 3. 创建新会话
 */

import { useRef, useEffect, useState } from 'react'
import { cn } from '@/utils/cn'
import { ChevronDown, Plus, FolderOpen } from 'lucide-react'
import { useSessionStore, getSessionEffectiveWorkspace } from '@/stores/sessionStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { StatusDot } from './StatusDot'
import { SessionList } from './SessionList'
import { WorkspaceMenu } from './WorkspaceMenu'

interface SessionIslandProps {
  onCreateSession?: () => void
}

export function SessionIsland({ onCreateSession }: SessionIslandProps) {
  const sessions = useSessionStore((state) => state.sessions)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const recentSessionIds = useSessionStore((state) => state.recentSessionIds)
  const isIslandExpanded = useSessionStore((state) => state.isIslandExpanded)
  const toggleIsland = useSessionStore((state) => state.toggleIsland)
  const collapseIsland = useSessionStore((state) => state.collapseIsland)
  const createSession = useSessionStore((state) => state.createSession)

  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId)

  const islandRef = useRef<HTMLDivElement>(null)
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false)

  // 获取当前活跃会话
  const activeSession = activeSessionId ? sessions.get(activeSessionId) : null

  // 获取会话有效工作区
  const effectiveWorkspaceId = activeSession
    ? getSessionEffectiveWorkspace(activeSession, currentWorkspaceId)
    : currentWorkspaceId

  const effectiveWorkspace = workspaces.find((w) => w.id === effectiveWorkspaceId)

  // 其他会话数量（用于显示指示器）
  const otherSessionsCount = recentSessionIds.filter(
    (id) => id !== activeSessionId && sessions.has(id)
  ).length

  // 点击外部关闭悬浮岛
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        islandRef.current &&
        !islandRef.current.contains(event.target as Node) &&
        isIslandExpanded
      ) {
        collapseIsland()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isIslandExpanded, collapseIsland])

  // 处理新建会话
  const handleCreateSession = () => {
    if (onCreateSession) {
      onCreateSession()
    } else {
      // 默认行为：创建自由会话
      createSession({
        type: 'free',
        workspaceId: currentWorkspaceId || undefined,
      })
    }
    collapseIsland()
  }

  // 处理工作区按钮点击
  const handleWorkspaceClick = () => {
    setShowWorkspaceMenu(!showWorkspaceMenu)
  }

  // 如果没有活跃会话，显示新建按钮
  if (!activeSession) {
    return (
      <div
        ref={islandRef}
        className={cn(
          'absolute top-3 left-1/2 -translate-x-1/2 z-20',
          'flex items-center justify-center'
        )}
      >
        <button
          onClick={handleCreateSession}
          className={cn(
            'px-4 py-2 rounded-xl',
            'flex items-center justify-center gap-2',
            'bg-primary text-white font-medium text-sm',
            'hover:bg-primary-hover transition-colors',
            'shadow-sm'
          )}
        >
          <Plus className="w-4 h-4" />
          新建会话
        </button>
      </div>
    )
  }

  return (
    <div
      ref={islandRef}
      className={cn(
        'absolute top-3 left-1/2 -translate-x-1/2 z-20'
      )}
    >
      {/* 悬浮岛主体 - 使用 div + role 避免按钮嵌套 */}
      <div
        role="button"
        tabIndex={0}
        onClick={toggleIsland}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleIsland()
          }
        }}
        className={cn(
          'min-w-[200px] max-w-[300px] py-2 px-3 rounded-xl cursor-pointer',
          'flex items-center gap-2',
          'bg-background-elevated border border-border',
          'hover:border-border-hover transition-all duration-200',
          'shadow-sm',
          isIslandExpanded && 'ring-2 ring-primary/20'
        )}
      >
        {/* 状态指示器 */}
        <StatusDot status={activeSession.status} size="md" />

        {/* 会话标题 */}
        <div className="flex-1 min-w-0 text-left">
          <div className="text-sm font-medium text-text-primary truncate">
            {activeSession.title}
          </div>
        </div>

        {/* 工作区指示 */}
        {effectiveWorkspace && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleWorkspaceClick()
            }}
            className={cn(
              'flex items-center gap-1 px-2 py-1 rounded-lg',
              'text-xs text-text-tertiary',
              'hover:bg-background-hover hover:text-text-secondary',
              'transition-colors shrink-0'
            )}
            title={`工作区: ${effectiveWorkspace.name}`}
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span className="truncate max-w-[60px]">
              {effectiveWorkspace.name}
            </span>
          </button>
        )}

        {/* 其他会话数量 */}
        {otherSessionsCount > 0 && (
          <span className={cn(
            'px-1.5 py-0.5 rounded-full text-xs',
            'bg-primary/10 text-primary font-medium',
            'shrink-0'
          )}>
            +{otherSessionsCount}
          </span>
        )}

        {/* 展开/折叠指示 */}
        <ChevronDown
          className={cn(
            'w-4 h-4 text-text-tertiary shrink-0 transition-transform duration-200',
            isIslandExpanded && 'rotate-180'
          )}
        />
      </div>

      {/* 展开的下拉列表 - 添加动画 */}
      <div
        className={cn(
          'absolute top-full left-1/2 -translate-x-1/2 pt-1 w-full min-w-[280px]',
          'transition-all duration-200 origin-top',
          isIslandExpanded
            ? 'opacity-100 scale-y-100 pointer-events-auto'
            : 'opacity-0 scale-y-95 pointer-events-none'
        )}
      >
        <SessionList
          onClose={collapseIsland}
          onCreateSession={handleCreateSession}
        />
      </div>

      {/* WorkspaceMenu */}
      {showWorkspaceMenu && activeSessionId && (
        <div className="absolute top-full right-0 mt-1 z-30">
          <WorkspaceMenu
            sessionId={activeSessionId}
            onClose={() => setShowWorkspaceMenu(false)}
          />
        </div>
      )}
    </div>
  )
}