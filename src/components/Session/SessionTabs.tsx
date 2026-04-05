/**
 * SessionTabs - 会话标签栏组件
 *
 * 支持功能:
 * - 显示所有打开的会话标签
 * - 切换会话
 * - 关闭会话
 * - 新建会话
 * - 显示会话状态
 */

import { memo, useCallback } from 'react'
import { cn } from '@/utils/cn'
import { Plus } from 'lucide-react'
import { SessionTab } from './SessionTab'
import {
  useSessionMetadataList,
  useActiveSessionId,
  useSessionManagerActions,
} from '@/stores/conversationStore/sessionStoreManager'
import { useWorkspaceStore } from '@/stores/workspaceStore'

export const SessionTabs = memo(function SessionTabs() {
  const sessions = useSessionMetadataList()
  const activeSessionId = useActiveSessionId()
  const { createSession, deleteSession, switchSession } = useSessionManagerActions()
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId)

  // 过滤静默会话
  const visibleSessions = sessions.filter(session => !session.silentMode)

  // 是否可以关闭（至少保留一个会话）
  const canClose = visibleSessions.length > 1

  // 新建会话
  const handleCreateSession = useCallback(() => {
    createSession({
      type: 'free',
      workspaceId: currentWorkspaceId || undefined,
    })
  }, [createSession, currentWorkspaceId])

  // 如果没有可见会话，显示新建按钮
  if (visibleSessions.length === 0) {
    return (
      <div className="flex items-center px-2 py-1 border-b border-border bg-background-surface">
        <button
          onClick={handleCreateSession}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg',
            'text-sm text-text-secondary hover:text-text-primary',
            'hover:bg-background-hover transition-colors'
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
      className="flex items-end gap-0 px-2 pt-1 border-b border-border bg-background-surface"
      role="tablist"
    >
      {/* 会话标签 */}
      {visibleSessions.map((session) => (
        <SessionTab
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
          onSelect={() => switchSession(session.id)}
          onClose={() => deleteSession(session.id)}
          canClose={canClose}
        />
      ))}

      {/* 新建按钮 */}
      <button
        onClick={handleCreateSession}
        className={cn(
          'flex items-center justify-center w-8 h-8 rounded-lg ml-1 mb-1',
          'text-text-muted hover:text-text-primary hover:bg-background-hover',
          'transition-colors'
        )}
        title="新建会话"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  )
})