/**
 * SessionSelector - 会话选择器组件
 *
 * 显示当前会话状态和名称，点击展开下拉列表
 */

import { memo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/utils/cn'
import { ChevronDown, Plus, X, Loader2 } from 'lucide-react'
import { StatusDot } from '@/components/Session/StatusDot'
import {
  useSessionMetadataList,
  useActiveSessionId,
  useSessionManagerActions,
} from '@/stores/conversationStore/sessionStoreManager'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { SessionMetadata } from '@/stores/conversationStore/types'
import type { SessionStatus } from '@/types/session'

interface SessionSelectorProps {
  isOpen: boolean
  onToggle: () => void
  onClose: () => void
}

export const SessionSelector = memo(function SessionSelector({
  isOpen,
  onToggle,
  onClose,
}: SessionSelectorProps) {
  const sessions = useSessionMetadataList()
  const activeSessionId = useActiveSessionId()
  const { createSession, deleteSession, switchSession } = useSessionManagerActions()
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId)

  const buttonRef = useRef<HTMLButtonElement>(null)

  // 获取当前活跃会话
  const activeSession = sessions.find(s => s.id === activeSessionId)

  // 过滤静默会话
  const visibleSessions = sessions.filter(session => !session.silentMode)

  // 新建会话
  const handleCreateSession = useCallback(() => {
    createSession({
      type: 'free',
      workspaceId: currentWorkspaceId || undefined,
    })
    onClose()
  }, [createSession, currentWorkspaceId, onClose])

  // 切换会话
  const handleSwitchSession = useCallback((sessionId: string) => {
    switchSession(sessionId)
    onClose()
  }, [switchSession, onClose])

  // 删除会话
  const handleDeleteSession = useCallback((sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    deleteSession(sessionId)
  }, [deleteSession])

  // 是否可以关闭（至少保留一个会话）
  const canClose = visibleSessions.length > 1

  // 无会话时显示新建按钮
  if (!activeSession) {
    return (
      <button
        onClick={handleCreateSession}
        className={cn(
          'flex items-center gap-1.5 px-3 h-7 rounded-full',
          'text-sm text-text-secondary hover:text-text-primary',
          'hover:bg-background-hover transition-colors'
        )}
      >
        <Plus className="w-4 h-4" />
        新建会话
      </button>
    )
  }

  return (
    <>
      {/* 会话选择按钮 */}
      <button
        ref={buttonRef}
        onClick={onToggle}
        className={cn(
          'flex items-center gap-2 px-3 h-7 rounded-full',
          'hover:bg-background-hover transition-colors cursor-pointer',
          isOpen && 'bg-background-hover'
        )}
      >
        {/* 状态指示器 */}
        <StatusDot status={mapSessionStatus(activeSession.status)} size="sm" />

        {/* 会话名称 */}
        <span className="text-sm font-medium text-text-primary max-w-[140px] truncate">
          {activeSession.title}
        </span>

        {/* 下拉箭头 */}
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 text-text-muted transition-transform duration-200',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      {/* 下拉面板 - Portal 渲染 */}
      {isOpen && createPortal(
        <SessionDropdown
          sessions={visibleSessions}
          activeSessionId={activeSessionId}
          canClose={canClose}
          onSwitch={handleSwitchSession}
          onDelete={handleDeleteSession}
          onCreate={handleCreateSession}
          onClose={onClose}
          anchorRef={buttonRef}
        />,
        document.body
      )}
    </>
  )
})

// ============================================================================
// SessionDropdown - 会话下拉面板
// ============================================================================

interface SessionDropdownProps {
  sessions: SessionMetadata[]
  activeSessionId: string | null
  canClose: boolean
  onSwitch: (sessionId: string) => void
  onDelete: (sessionId: string, e: React.MouseEvent) => void
  onCreate: () => void
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
}

const SessionDropdown = memo(function SessionDropdown({
  sessions,
  activeSessionId,
  canClose,
  onSwitch,
  onDelete,
  onCreate,
  onClose,
  anchorRef,
}: SessionDropdownProps) {
  const dropdownRef = useRef<HTMLDivElement>(null)

  // 计算位置
  const getDropdownStyle = () => {
    if (!anchorRef.current) return {}
    const rect = anchorRef.current.getBoundingClientRect()
    return {
      position: 'fixed' as const,
      top: rect.bottom + 8,
      left: rect.left - 40, // 稍微左偏以居中
      width: 240,
    }
  }

  // 点击外部关闭
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <>
      {/* 背景遮罩 */}
      <div
        className="fixed inset-0 z-40"
        onClick={handleBackdropClick}
      />

      {/* 下拉面板 */}
      <div
        ref={dropdownRef}
        data-floating-dropdown="session"
        style={getDropdownStyle()}
        className={cn(
          'z-50 bg-background-elevated border border-border rounded-xl',
          'shadow-xl overflow-hidden',
          'animate-in fade-in-0 zoom-in-95 duration-150'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="px-3 py-2 border-b border-border-subtle flex items-center justify-between">
          <span className="text-xs font-medium text-text-tertiary">会话列表</span>
          <button
            onClick={onCreate}
            className="text-xs text-primary hover:text-primary-hover transition-colors"
          >
            + 新建会话
          </button>
        </div>

        {/* 会话列表 */}
        <div className="max-h-64 overflow-y-auto">
          {sessions.length === 0 ? (
            <div className="py-4 text-center text-sm text-text-tertiary">
              暂无会话
            </div>
          ) : (
            sessions.map((session) => {
              const isActive = session.id === activeSessionId
              const isRunning = session.status === 'running' || session.status === 'background-running'

              return (
                <div
                  key={session.id}
                  onClick={() => onSwitch(session.id)}
                  className={cn(
                    'group flex items-center gap-2 px-3 py-2 cursor-pointer',
                    'hover:bg-background-hover transition-colors',
                    isActive && 'bg-primary/5'
                  )}
                >
                  {/* 状态指示器 */}
                  <StatusDot status={mapSessionStatus(session.status)} size="sm" />

                  {/* 会话名称 */}
                  <span
                    className={cn(
                      'flex-1 text-sm truncate',
                      isActive ? 'text-primary font-medium' : 'text-text-secondary'
                    )}
                  >
                    {session.title}
                  </span>

                  {/* 活跃指示 */}
                  {isActive && (
                    <span className="text-xs text-primary">●</span>
                  )}

                  {/* 运行中指示器 */}
                  {isRunning && !isActive && (
                    <Loader2 className="w-3 h-3 text-primary animate-spin shrink-0" />
                  )}

                  {/* 关闭按钮 */}
                  {canClose && !isActive && (
                    <button
                      onClick={(e) => onDelete(session.id, e)}
                      className={cn(
                        'opacity-0 group-hover:opacity-100 p-1 rounded',
                        'text-text-muted hover:text-danger hover:bg-background-hover',
                        'transition-all'
                      )}
                      title="关闭会话"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* 底部提示 */}
        <div className="px-3 py-2 border-t border-border-subtle text-xs text-text-tertiary text-center">
          共 {sessions.length} 个会话 · 点击切换
        </div>
      </div>
    </>
  )
})

// ============================================================================
// Helper Functions
// ============================================================================

function mapSessionStatus(status: SessionMetadata['status']): SessionStatus {
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