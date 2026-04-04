/**
 * SessionsPanel - 左侧会话管理面板
 *
 * 功能:
 * 1. 搜索会话
 * 2. 按日期/工作区分组显示
 * 3. 会话项操作 (重命名、删除)
 * 4. 新建会话
 */

import { useState, useMemo, useRef, useEffect } from 'react'
import { Search, Plus, Edit3, Trash2, Calendar, FolderOpen } from 'lucide-react'
import { cn } from '@/utils/cn'
import { useSessionStore } from '@/stores/sessionStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { getSessionEffectiveWorkspace } from '@/stores/sessionStore'
import { StatusDot } from './StatusDot'
import type { ChatSession } from '@/types/session'

type GroupMode = 'date' | 'workspace'

interface SessionGroup {
  label: string
  sessions: ChatSession[]
}

/**
 * 判断日期所属分组
 */
function getDateGroup(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()

  // 重置到当天开始
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000)
  const weekStart = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000)

  if (date >= todayStart) {
    return 'today'
  } else if (date >= yesterdayStart) {
    return 'yesterday'
  } else if (date >= weekStart) {
    return 'week'
  } else {
    return 'earlier'
  }
}

/**
 * 格式化时间为相对时间
 */
function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return ''

  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMinutes = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMinutes < 1) return '刚刚'
  if (diffMinutes < 60) return `${diffMinutes}分钟前`
  if (diffHours < 24) return `${diffHours}小时前`
  if (diffDays < 7) return `${diffDays}天前`

  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

export function SessionsPanel() {
  // Store state
  const sessions = useSessionStore((state) => state.sessions)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const switchSession = useSessionStore((state) => state.switchSession)
  const deleteSession = useSessionStore((state) => state.deleteSession)
  const renameSession = useSessionStore((state) => state.renameSession)
  const createSession = useSessionStore((state) => state.createSession)

  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId)

  // Local state
  const [searchQuery, setSearchQuery] = useState('')
  const [groupMode, setGroupMode] = useState<GroupMode>('date')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  // 获取所有会话列表
  const allSessions = useMemo(() => {
    return Array.from(sessions.values())
  }, [sessions])

  // 搜索过滤
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return allSessions

    const keyword = searchQuery.toLowerCase()
    return allSessions.filter((s) => s.title.toLowerCase().includes(keyword))
  }, [allSessions, searchQuery])

  // 按日期分组
  const dateGroups = useMemo<SessionGroup[]>(() => {
    const groups: Record<string, ChatSession[]> = {
      today: [],
      yesterday: [],
      week: [],
      earlier: [],
    }

    filteredSessions.forEach((session) => {
      const groupKey = getDateGroup(session.lastMessageAt || session.updatedAt)
      groups[groupKey].push(session)
    })

    const labels: Record<string, string> = {
      today: '今天',
      yesterday: '昨天',
      week: '本周',
      earlier: '更早',
    }

    return Object.entries(groups)
      .filter(([, sessions]) => sessions.length > 0)
      .map(([key, sessions]) => ({
        label: labels[key],
        sessions: sessions.sort((a, b) =>
          new Date(b.lastMessageAt || b.updatedAt).getTime() -
          new Date(a.lastMessageAt || a.updatedAt).getTime()
        ),
      }))
  }, [filteredSessions])

  // 按工作区分组
  const workspaceGroups = useMemo<SessionGroup[]>(() => {
    const groups: Record<string, ChatSession[]> = {}

    // 初始化所有工作区
    workspaces.forEach((w) => {
      groups[w.id] = []
    })

    // 自由会话组
    groups['free'] = []

    filteredSessions.forEach((session) => {
      if (session.type === 'free') {
        groups['free'].push(session)
      } else if (session.workspaceId) {
        if (!groups[session.workspaceId]) {
          groups[session.workspaceId] = []
        }
        groups[session.workspaceId].push(session)
      }
    })

    return Object.entries(groups)
      .filter(([, sessions]) => sessions.length > 0)
      .map(([key, sessions]) => {
        let label: string
        if (key === 'free') {
          label = '自由会话'
        } else {
          const workspace = workspaces.find((w) => w.id === key)
          label = workspace?.name || '未知工作区'
        }

        return {
          label,
          sessions: sessions.sort((a, b) =>
            new Date(b.lastMessageAt || b.updatedAt).getTime() -
            new Date(a.lastMessageAt || a.updatedAt).getTime()
          ),
        }
      })
  }, [filteredSessions, workspaces])

  // 当前分组
  const currentGroups = groupMode === 'date' ? dateGroups : workspaceGroups

  // 获取工作区名称
  const getWorkspaceName = (session: ChatSession): string | undefined => {
    const effectiveId = getSessionEffectiveWorkspace(session, currentWorkspaceId)
    if (!effectiveId) return undefined
    const workspace = workspaces.find((w) => w.id === effectiveId)
    return workspace?.name
  }

  // 开始编辑
  const handleStartEdit = (session: ChatSession) => {
    setEditingId(session.id)
    setEditingTitle(session.title)
  }

  // 保存编辑
  const handleSaveEdit = () => {
    if (editingId && editingTitle.trim()) {
      renameSession(editingId, editingTitle.trim())
    }
    setEditingId(null)
    setEditingTitle('')
  }

  // 取消编辑
  const handleCancelEdit = () => {
    setEditingId(null)
    setEditingTitle('')
  }

  // 删除会话
  const handleDelete = (session: ChatSession) => {
    const confirmed = confirm(`确定删除会话 "${session.title}" 吗？`)
    if (confirmed) {
      deleteSession(session.id)
    }
  }

  // 新建会话
  const handleCreateSession = () => {
    createSession({
      type: 'free',
      engineId: 'claude-code',
    })
  }

  // 编辑输入框自动聚焦
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  // 统计
  const stats = {
    total: allSessions.length,
    idle: allSessions.filter((s) => s.status === 'idle').length,
    running: allSessions.filter((s) => s.status === 'running').length,
  }

  return (
    <div className="flex flex-col h-full bg-background-elevated">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-primary">
            会话管理
            <span className="ml-2 text-xs font-normal text-text-secondary">
              ({stats.total} 个会话)
            </span>
          </h2>
          <button
            onClick={handleCreateSession}
            className="p-1.5 rounded-lg bg-primary text-white hover:bg-primary/90 transition-all"
            title="新建会话"
          >
            <Plus size={16} />
          </button>
        </div>

        {/* 搜索栏 */}
        <div className="mb-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索会话..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 text-text-primary placeholder-text-tertiary"
            />
          </div>
        </div>

        {/* 分组切换 */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setGroupMode('date')}
            className={cn(
              'flex items-center gap-1 px-2 py-1 text-xs rounded transition-all',
              groupMode === 'date'
                ? 'bg-primary/20 text-primary'
                : 'hover:bg-background-hover text-text-secondary'
            )}
          >
            <Calendar size={12} />
            按日期
          </button>
          <button
            onClick={() => setGroupMode('workspace')}
            className={cn(
              'flex items-center gap-1 px-2 py-1 text-xs rounded transition-all',
              groupMode === 'workspace'
                ? 'bg-primary/20 text-primary'
                : 'hover:bg-background-hover text-text-secondary'
            )}
          >
            <FolderOpen size={12} />
            按工作区
          </button>
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {currentGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
            <p className="text-sm">
              {searchQuery ? '没有找到匹配的会话' : '暂无会话'}
            </p>
            {!searchQuery && (
              <button
                onClick={handleCreateSession}
                className="mt-4 px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 transition-all"
              >
                新建会话
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {currentGroups.map((group) => (
              <div key={group.label}>
                {/* Group header */}
                <div className="text-xs font-medium text-text-tertiary mb-2 px-1">
                  {group.label}
                  <span className="ml-1 text-text-quaternary">
                    ({group.sessions.length})
                  </span>
                </div>

                {/* Group sessions */}
                <div className="space-y-1">
                  {group.sessions.map((session) => (
                    <SessionItemWithActions
                      key={session.id}
                      session={session}
                      workspaceName={groupMode === 'date' ? getWorkspaceName(session) : undefined}
                      isActive={session.id === activeSessionId}
                      isEditing={session.id === editingId}
                      editingTitle={editingTitle}
                      editInputRef={editInputRef}
                      onClick={() => {
                        if (editingId !== session.id) {
                          switchSession(session.id)
                        }
                      }}
                      onEdit={() => handleStartEdit(session)}
                      onDelete={() => handleDelete(session)}
                      onEditingTitleChange={setEditingTitle}
                      onSaveEdit={handleSaveEdit}
                      onCancelEdit={handleCancelEdit}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border">
        <button
          onClick={handleCreateSession}
          className={cn(
            'w-full flex items-center justify-center gap-2',
            'py-2 rounded-lg text-sm font-medium',
            'bg-primary text-white hover:bg-primary-hover',
            'transition-colors'
          )}
        >
          <Plus size={16} />
          新建会话
        </button>
      </div>
    </div>
  )
}

/**
 * 会话项组件（带操作按钮）
 */
interface SessionItemWithActionsProps {
  session: ChatSession
  workspaceName?: string
  isActive: boolean
  isEditing: boolean
  editingTitle: string
  editInputRef: React.RefObject<HTMLInputElement | null>
  onClick: () => void
  onEdit: () => void
  onDelete: () => void
  onEditingTitleChange: (title: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
}

function SessionItemWithActions({
  session,
  workspaceName,
  isActive,
  isEditing,
  editingTitle,
  editInputRef,
  onClick,
  onEdit,
  onDelete,
  onEditingTitleChange,
  onSaveEdit,
  onCancelEdit,
}: SessionItemWithActionsProps) {
  const [showActions, setShowActions] = useState(false)
  const timeAgo = formatTimeAgo(session.lastMessageAt || session.updatedAt)

  return (
    <div
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      className={cn(
        'relative w-full px-3 py-2 rounded-lg transition-colors',
        'flex items-center gap-2.5',
        isActive
          ? 'bg-primary/10 border border-primary/20'
          : 'hover:bg-background-hover'
      )}
    >
      {/* 状态指示器 */}
      <StatusDot status={session.status} size="sm" />

      {/* 会话信息 */}
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            ref={editInputRef}
            type="text"
            value={editingTitle}
            onChange={(e) => onEditingTitleChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onSaveEdit()
              } else if (e.key === 'Escape') {
                onCancelEdit()
              }
            }}
            onBlur={onSaveEdit}
            className={cn(
              'w-full px-1.5 py-0.5 text-sm rounded',
              'bg-background-surface border border-primary/50',
              'focus:outline-none focus:ring-2 focus:ring-primary/50',
              'text-text-primary'
            )}
          />
        ) : (
          <>
            {/* 标题 */}
            <div
              onClick={onClick}
              className={cn(
                'text-sm font-medium truncate cursor-pointer',
                isActive ? 'text-primary' : 'text-text-primary'
              )}
            >
              {session.title}
            </div>

            {/* 元信息 */}
            <div className="flex items-center gap-2 mt-0.5 text-xs text-text-tertiary">
              {workspaceName && (
                <span className="truncate max-w-[100px]">
                  {workspaceName}
                </span>
              )}
              {timeAgo && (
                <span className="shrink-0">
                  {timeAgo}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* 消息数量 */}
      {!isEditing && session.messageCount > 0 && (
        <span className={cn(
          'text-xs px-1.5 py-0.5 rounded-full shrink-0',
          isActive
            ? 'bg-primary/20 text-primary'
            : 'bg-background-surface text-text-tertiary'
        )}>
          {session.messageCount}
        </span>
      )}

      {/* 操作按钮 */}
      {!isEditing && showActions && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onEdit()
            }}
            className={cn(
              'p-1 rounded transition-colors',
              'text-text-tertiary hover:text-text-primary hover:bg-background-surface'
            )}
            title="重命名"
          >
            <Edit3 size={14} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className={cn(
              'p-1 rounded transition-colors',
              'text-text-tertiary hover:text-red-500 hover:bg-red-50'
            )}
            title="删除"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </div>
  )
}