import { useState } from 'react'
import { ChevronUp, ChevronDown, Loader2 } from 'lucide-react'
import { useAssistantStore } from '../store/assistantStore'
import { SessionTab } from './SessionTab'
import { cn } from '../../utils'

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
        <div
          key={idx}
          className="text-xs font-mono text-text-muted flex items-start gap-2"
        >
          <span className="text-text-tertiary shrink-0">
            {new Date(event.timestamp).toLocaleTimeString()}
          </span>
          <span className="text-text-primary">
            {event.data.message || event.data.content || event.data.tool}
          </span>
        </div>
      ))}
    </div>
  )
}
