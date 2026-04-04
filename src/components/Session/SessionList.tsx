/**
 * SessionList - 会话下拉列表组件
 */

import { cn } from '@/utils/cn'
import { Plus, Settings } from 'lucide-react'
import { useSessionStore, getSessionEffectiveWorkspace } from '@/stores/sessionStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useViewStore } from '@/stores/viewStore'
import { switchSessionWithSync } from '@/stores/sessionSync'
import { SessionListItem } from './SessionListItem'

interface SessionListProps {
  onClose: () => void
  onCreateSession: () => void
}

export function SessionList({ onClose, onCreateSession }: SessionListProps) {
  const sessions = useSessionStore((state) => state.sessions)
  const recentSessionIds = useSessionStore((state) => state.recentSessionIds)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)

  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId)

  const setLeftPanelType = useViewStore((state) => state.setLeftPanelType)

  // 获取最近会话（最多 5 个）
  const recentSessions = recentSessionIds
    .slice(0, 5)
    .map((id) => sessions.get(id))
    .filter((s) => s !== undefined)

  // 获取工作区名称
  const getWorkspaceName = (sessionId: string): string | undefined => {
    const session = sessions.get(sessionId)
    if (!session) return undefined

    const effectiveId = getSessionEffectiveWorkspace(session, currentWorkspaceId)
    if (!effectiveId) return undefined

    const workspace = workspaces.find((w) => w.id === effectiveId)
    return workspace?.name
  }

  // 切换会话（带消息同步）
  const handleSwitchSession = async (sessionId: string) => {
    const success = await switchSessionWithSync(sessionId)
    if (success) {
      onClose()
    }
  }

  // 打开会话管理面板
  const handleOpenManage = () => {
    setLeftPanelType('sessions')
    onClose()
  }

  return (
    <div className="w-[280px] py-2 bg-background-elevated border border-border rounded-xl shadow-lg">
      {/* 会话列表 */}
      <div className="px-2 mb-2">
        <div className="text-xs font-medium text-text-tertiary px-1 mb-1.5">
          最近会话
        </div>

        {recentSessions.length === 0 ? (
          <div className="py-4 text-center text-sm text-text-tertiary">
            暂无会话记录
          </div>
        ) : (
          <div className="space-y-1">
            {recentSessions.map((session) => (
              <SessionListItem
                key={session.id}
                session={session}
                workspaceName={getWorkspaceName(session.id)}
                isActive={session.id === activeSessionId}
                onClick={() => handleSwitchSession(session.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 分割线 */}
      <div className="mx-2 my-1 border-t border-border" />

      {/* 底部操作按钮 */}
      <div className="px-2 flex gap-2">
        <button
          onClick={onCreateSession}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5',
            'py-2 rounded-lg text-sm font-medium',
            'bg-primary text-white hover:bg-primary-hover',
            'transition-colors'
          )}
        >
          <Plus className="w-4 h-4" />
          新建会话
        </button>

        <button
          onClick={handleOpenManage}
          className={cn(
            'flex items-center justify-center gap-1.5',
            'px-3 py-2 rounded-lg text-sm',
            'bg-background-surface text-text-secondary hover:bg-background-hover',
            'border border-border transition-colors'
          )}
          title="管理会话"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}