import { useState } from 'react'
import { ChevronUp, ChevronDown, Loader2, CheckCircle, XCircle, Bell, FileText, Code, Wrench } from 'lucide-react'
import { useAssistantStore } from '../store/assistantStore'
import { SessionTab } from './SessionTab'
import { cn } from '../../utils'
import type { ClaudeCodeExecutionEvent } from '../types'

/**
 * Claude Code 多会话面板
 */
export function ClaudeCodeSessionPanel() {
  const [isCollapsed, setIsCollapsed] = useState(true)
  const {
    claudeCodeSessions,
    executionPanelSessionId,
    setExecutionPanelSession,
  } = useAssistantStore()

  const sessions = Array.from(claudeCodeSessions.values())
  const runningSessions = sessions.filter((s) => s.status === 'running')

  if (sessions.length === 0) return null

  return (
    <div
      className={cn(
        'border-t border-border transition-all shrink-0 bg-background-elevated',
        isCollapsed ? 'h-10' : 'h-48'
      )}
    >
      {/* 折叠状态栏 */}
      <div
        className="flex items-center justify-between px-4 h-10 cursor-pointer hover:bg-background-hover"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-2">
          {runningSessions.length > 0 && (
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
          )}
          <span className="text-sm text-text-muted">
            {runningSessions.length > 0
              ? `${runningSessions.length} 个会话运行中`
              : 'Claude Code 会话'}
          </span>
        </div>
        {isCollapsed ? (
          <ChevronUp className="w-4 h-4 text-text-muted" />
        ) : (
          <ChevronDown className="w-4 h-4 text-text-muted" />
        )}
      </div>

      {/* 展开内容 */}
      {!isCollapsed && (
        <>
          {/* 会话标签栏 */}
          <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50 overflow-x-auto">
            {sessions.map((session) => (
              <SessionTab
                key={session.id}
                session={session}
                isActive={executionPanelSessionId === session.id}
                onClick={() => setExecutionPanelSession(session.id)}
              />
            ))}
          </div>

          {/* 会话内容 */}
          {executionPanelSessionId && (
            <div className="h-[calc(100%-78px)] overflow-auto px-4 py-2">
              <SessionContent sessionId={executionPanelSessionId} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * 会话内容
 */
function SessionContent({ sessionId }: { sessionId: string }) {
  const { getClaudeCodeSession } = useAssistantStore()
  const session = getClaudeCodeSession(sessionId)

  if (!session) return null

  if (session.events.length === 0) {
    return (
      <div className="text-sm text-text-muted text-center py-4">
        等待执行...
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {session.events.map((event, idx) => (
        <EventItem key={idx} event={event} />
      ))}
    </div>
  )
}

/**
 * 单个事件项
 */
function EventItem({ event }: { event: ClaudeCodeExecutionEvent }) {
  const time = new Date(event.timestamp).toLocaleTimeString()

  const getIcon = () => {
    switch (event.type) {
      case 'tool_call':
        return <Wrench className="w-3 h-3 text-primary" />
      case 'assistant_message':
        return <FileText className="w-3 h-3 text-text-secondary" />
      case 'session_start':
        return <Loader2 className="w-3 h-3 text-primary animate-spin" />
      case 'session_end':
        return <CheckCircle className="w-3 h-3 text-success" />
      case 'error':
        return <XCircle className="w-3 h-3 text-danger" />
      default:
        return <Code className="w-3 h-3 text-text-muted" />
    }
  }

  const getContent = () => {
    if (event.data.error) {
      return <span className="text-danger">{event.data.error}</span>
    }
    if (event.data.tool) {
      return (
        <span>
          <span className="text-primary">{event.data.tool}</span>
          {event.data.message && (
            <span className="text-text-muted ml-1">- {event.data.message}</span>
          )}
        </span>
      )
    }
    if (event.data.content) {
      const content = event.data.content
      const truncated = content.length > 100 ? content.slice(0, 100) + '...' : content
      return <span className="text-text-primary whitespace-pre-wrap">{truncated}</span>
    }
    if (event.data.message) {
      return <span className="text-text-muted">{event.data.message}</span>
    }
    return null
  }

  return (
    <div className="text-xs flex items-start gap-2 py-1 hover:bg-background-hover px-1 rounded">
      <span className="text-text-tertiary shrink-0 w-16">{time}</span>
      <span className="shrink-0 mt-0.5">{getIcon()}</span>
      <span className="flex-1 min-w-0">{getContent()}</span>
    </div>
  )
}

/**
 * 完成通知面板
 */
export function CompletionNotificationPanel() {
  const { completionNotifications, hasUnreadNotifications, markNotificationHandled } = useAssistantStore()
  const [isExpanded, setIsExpanded] = useState(false)

  const pendingNotifications = completionNotifications.filter((n) => !n.handled)

  if (pendingNotifications.length === 0) return null

  return (
    <div className="border-t border-border bg-background-surface">
      {/* 折叠状态栏 */}
      <div
        className="flex items-center justify-between px-4 h-10 cursor-pointer hover:bg-background-hover"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <Bell className={cn('w-4 h-4', hasUnreadNotifications ? 'text-primary' : 'text-text-muted')} />
          <span className="text-sm text-text-primary">
            {pendingNotifications.length} 个任务完成待处理
          </span>
        </div>
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-text-muted" />
        ) : (
          <ChevronUp className="w-4 h-4 text-text-muted" />
        )}
      </div>

      {/* 展开内容 */}
      {isExpanded && (
        <div className="px-4 py-2 space-y-2 max-h-48 overflow-auto">
          {pendingNotifications.map((notification) => (
            <div
              key={notification.id}
              className="p-2 bg-background-elevated rounded border border-border"
            >
              <div className="text-xs text-text-tertiary mb-1">
                {new Date(notification.createdAt).toLocaleTimeString()}
              </div>
              <div className="text-sm text-text-primary mb-1">
                {notification.prompt.slice(0, 50)}...
              </div>
              <div className="text-xs text-text-muted mb-2">
                {notification.resultSummary}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => markNotificationHandled(notification.id, 'immediate')}
                  className="px-2 py-1 text-xs bg-primary text-white rounded hover:bg-primary/80"
                >
                  立即处理
                </button>
                <button
                  onClick={() => markNotificationHandled(notification.id, 'delayed')}
                  className="px-2 py-1 text-xs bg-background-hover text-text-secondary rounded hover:bg-background-surface"
                >
                  稍后处理
                </button>
                <button
                  onClick={() => markNotificationHandled(notification.id, 'ignored')}
                  className="px-2 py-1 text-xs text-text-muted hover:text-text-secondary"
                >
                  忽略
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
