import { Loader2, CheckCircle, XCircle } from 'lucide-react'
import type { ClaudeCodeSessionState } from '../types'
import { cn } from '../../utils'

interface SessionTabProps {
  session: ClaudeCodeSessionState
  isActive: boolean
  onClick: () => void
}

/**
 * 会话标签
 */
export function SessionTab({ session, isActive, onClick }: SessionTabProps) {
  return (
    <button
      className={cn(
        'flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
        isActive
          ? 'bg-primary/20 text-primary'
          : 'text-text-muted hover:bg-background-surface'
      )}
      onClick={onClick}
    >
      {/* 状态图标 */}
      {session.status === 'running' && (
        <Loader2 className="w-3 h-3 animate-spin" />
      )}
      {session.status === 'completed' && (
        <CheckCircle className="w-3 h-3 text-success" />
      )}
      {session.status === 'error' && (
        <XCircle className="w-3 h-3 text-danger" />
      )}

      {/* 标签 */}
      <span>{session.label}</span>

      {/* 类型标记 */}
      {session.type === 'primary' && (
        <span className="text-[10px] text-text-tertiary">主</span>
      )}
      {session.type === 'background' && (
        <span className="text-[10px] text-text-tertiary">后台</span>
      )}
    </button>
  )
}
