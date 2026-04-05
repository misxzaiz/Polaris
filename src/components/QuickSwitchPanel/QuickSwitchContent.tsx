/**
 * QuickSwitchContent - 快速切换面板内容组件
 *
 * 展示会话列表、工作区信息和新建会话按钮
 */

import { memo } from 'react'
import { cn } from '@/utils/cn'
import { Plus, FolderOpen, Loader2 } from 'lucide-react'
import { StatusDot } from '@/components/Session/StatusDot'
import type { QuickSessionInfo, QuickWorkspaceInfo } from './types'

interface QuickSwitchContentProps {
  /** 会话列表 */
  sessions: QuickSessionInfo[]
  /** 当前工作区信息 */
  workspace: QuickWorkspaceInfo | null
  /** 切换会话回调 */
  onSwitchSession: (sessionId: string) => void
  /** 新建会话回调 */
  onCreateSession: () => void
  /** 悬停进入回调 */
  onMouseEnter: () => void
  /** 悬停离开回调 */
  onMouseLeave: () => void
}

export const QuickSwitchContent = memo(function QuickSwitchContent({
  sessions,
  workspace,
  onSwitchSession,
  onCreateSession,
  onMouseEnter,
  onMouseLeave,
}: QuickSwitchContentProps) {
  // 获取当前活跃会话
  const activeSession = sessions.find(s => s.isActive)

  return (
    <div
      className={cn(
        // 位置：触发器左侧
        'absolute right-8 -top-2',
        // 尺寸：240px宽
        'w-60',
        // 玻璃风格
        'bg-background-elevated/95 backdrop-blur-2xl',
        // 边框和圆角
        'border border-border/50 rounded-2xl',
        // 阴影
        'shadow-xl shadow-black/10',
        // 入场动画
        'animate-in fade-in-0 zoom-in-95 duration-150',
        // 内容布局
        'overflow-hidden'
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Header: 当前状态 */}
      <div className="px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-3">
          {activeSession && (
            <>
              <StatusDot status={activeSession.status} size="md" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-primary truncate">
                  {activeSession.title}
                </div>
                <div className="text-xs text-text-tertiary">
                  {getStatusLabel(activeSession.status)}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Sessions: 会话列表 */}
      <div className="px-4 py-2">
        <div className="text-xs text-text-tertiary uppercase tracking-wide mb-2">
          会话
        </div>

        <div className="space-y-1">
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => onSwitchSession(session.id)}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-2 rounded-lg',
                'text-sm transition-colors',
                session.isActive
                  ? 'bg-primary/10 border-l-2 border-l-primary text-primary'
                  : 'hover:bg-background-hover text-text-secondary'
              )}
            >
              <StatusDot status={session.status} size="sm" />
              <span className="truncate">{session.title}</span>
              {session.status === 'running' && (
                <Loader2 className="w-3 h-3 animate-spin text-primary ml-auto" />
              )}
              {session.isActive && (
                <span className="text-xs text-primary ml-auto">当前</span>
              )}
            </button>
          ))}
        </div>

        {/* 新建会话按钮 */}
        <button
          onClick={onCreateSession}
          className={cn(
            'w-full mt-2 px-3 py-2 rounded-lg',
            'border border-dashed border-border-subtle',
            'text-xs text-text-tertiary',
            'hover:bg-background-hover hover:text-text-secondary',
            'transition-colors'
          )}
        >
          <Plus className="w-3 h-3 inline mr-1" />
          新建会话
        </button>
      </div>

      {/* Workspace: 工作区信息 */}
      {workspace && (
        <div className="px-4 py-2 border-t border-border-subtle">
          <div className="text-xs text-text-tertiary uppercase tracking-wide mb-2">
            工作区
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/5">
            <FolderOpen className="w-3.5 h-3.5 text-text-muted" />
            <span className="text-sm truncate">{workspace.name}</span>
            {workspace.contextCount > 0 && (
              <span className="text-xs bg-primary text-white px-1.5 rounded">
                +{workspace.contextCount}
              </span>
            )}
            <span className="text-xs text-text-tertiary ml-auto">主工作区</span>
          </div>
        </div>
      )}
    </div>
  )
})

// 状态标签映射
function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    idle: '空闲',
    running: '运行中',
    waiting: '等待输入',
    error: '错误',
    'background-running': '后台运行',
  }
  return labels[status] || '未知'
}