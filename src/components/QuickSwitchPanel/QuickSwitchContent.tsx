/**
 * QuickSwitchContent - 快速切换面板内容组件
 *
 * 极简设计：专注于快速切换会话
 */

import { memo, useMemo, useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/utils/cn'
import { Plus, Loader2, X, FolderOpen, ChevronDown, Lock, Check, Download, Clock, FolderPlus } from 'lucide-react'
import { StatusSymbol } from './StatusSymbol'
import { CreateWorkspaceModal } from '@/components/Workspace/CreateWorkspaceModal'
import { createLogger } from '@/utils/logger'
import type { QuickSessionInfo, QuickWorkspaceInfo } from './types'

const log = createLogger('QuickSwitchContent')

interface QuickSwitchContentProps {
  /** 会话列表 */
  sessions: QuickSessionInfo[]
  /** 当前工作区信息 */
  workspace: QuickWorkspaceInfo | null
  /** 所有工作区列表 */
  workspaces: QuickWorkspaceInfo[]
  /** 关联工作区ID列表 */
  contextWorkspaceIds: string[]
  /** 工作区是否锁定 */
  isWorkspaceLocked: boolean
  /** 切换会话回调 */
  onSwitchSession: (sessionId: string) => void
  /** 删除会话回调 */
  onDeleteSession: (sessionId: string) => void
  /** 新建会话回调 */
  onCreateSession: () => void
  /** 切换主工作区回调 */
  onSwitchWorkspace: (workspaceId: string) => void
  /** 切换关联工作区回调 */
  onToggleContextWorkspace: (workspaceId: string) => void
  /** 导出聊天回调 */
  onExport?: () => void
  /** 导出是否进行中 */
  isExporting?: boolean
  /** 打开历史会话回调 */
  onOpenHistory?: () => void
  /** 工作区下拉是否打开的 ref（同步更新，避免面板关闭） */
  workspaceDropdownOpenRef?: React.MutableRefObject<boolean>
  /** 悬停进入回调 */
  onMouseEnter: () => void
  /** 悬停离开回调 */
  onMouseLeave: () => void
}

export const QuickSwitchContent = memo(function QuickSwitchContent({
  sessions,
  workspace,
  workspaces,
  contextWorkspaceIds,
  isWorkspaceLocked,
  onSwitchSession,
  onDeleteSession,
  onCreateSession,
  onSwitchWorkspace,
  onToggleContextWorkspace,
  onExport,
  isExporting = false,
  onOpenHistory,
  workspaceDropdownOpenRef,
  onMouseEnter,
  onMouseLeave,
}: QuickSwitchContentProps) {
  // 工作区下拉状态
  const [isWorkspaceDropdownOpen, setIsWorkspaceDropdownOpen] = useState(false)
  const workspaceButtonRef = useRef<HTMLButtonElement>(null)
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 })

  // 获取当前活跃会话
  const activeSession = sessions.find(s => s.isActive)

  // 工作区显示名称
  const workspaceDisplayName = workspace?.name || '工作区'

  // 同步下拉状态到 ref（同步更新，无延迟）
  useEffect(() => {
    if (workspaceDropdownOpenRef) {
      workspaceDropdownOpenRef.current = isWorkspaceDropdownOpen
    }
  }, [isWorkspaceDropdownOpen, workspaceDropdownOpenRef])

  // 打开/关闭下拉时同步更新 ref
  const handleToggleDropdown = (open: boolean) => {
    log.info('handleToggleDropdown', { open, currentRef: workspaceDropdownOpenRef?.current })
    if (workspaceDropdownOpenRef) {
      workspaceDropdownOpenRef.current = open
    }
    // 打开时立即计算位置（避免先渲染后计算导致闪烁）
    if (open && workspaceButtonRef.current) {
      const rect = workspaceButtonRef.current.getBoundingClientRect()
      log.info('立即计算下拉位置', { top: rect.bottom + 4, left: rect.left })
      setDropdownPosition({
        top: rect.bottom + 4,
        left: rect.left,
      })
    }
    setIsWorkspaceDropdownOpen(open)
  }

  // 点击外部关闭下拉
  useEffect(() => {
    if (!isWorkspaceDropdownOpen) return

    log.info('注册点击外部监听')

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Element
      const clickedButton = workspaceButtonRef.current?.contains(target)
      const clickedDropdown = !!target.closest('[data-workspace-dropdown]')
      log.info('handleClickOutside', { clickedButton, clickedDropdown, targetTag: target.tagName })
      if (
        workspaceButtonRef.current &&
        !clickedButton &&
        !clickedDropdown
      ) {
        log.info('点击外部，关闭下拉')
        handleToggleDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isWorkspaceDropdownOpen])

  // 计算下拉位置（使用 useLayoutEffect 避免闪烁）
  useLayoutEffect(() => {
    if (isWorkspaceDropdownOpen && workspaceButtonRef.current) {
      const rect = workspaceButtonRef.current.getBoundingClientRect()
      setDropdownPosition({
        top: rect.bottom + 4,
        left: rect.left,
      })
    }
  }, [isWorkspaceDropdownOpen])

  // 按最近访问排序工作区
  const sortedWorkspaces = useMemo(() => {
    return [...workspaces].sort((a, b) => {
      if (a.isMain) return -1
      if (b.isMain) return 1
      if (a.isContext && !b.isContext) return -1
      if (!a.isContext && b.isContext) return 1
      return 0
    })
  }, [workspaces])

  // 计算关联工作区数量
  const totalContextCount = contextWorkspaceIds.length + (workspace ? 1 : 0)

  return (
    <div
      className={cn(
        // 尺寸：更紧凑
        'w-56',
        // 深色玻璃风格
        'bg-background-elevated/98 backdrop-blur-2xl',
        // 边框
        'border border-border/40',
        'rounded-2xl rounded-tr-none',
        // 阴影
        'shadow-2xl shadow-black/30',
        // 入场动画
        'animate-in fade-in-0 slide-in-from-right-2 duration-200',
        // 内容布局
        'overflow-hidden'
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* 顶部发光线 */}
      <div className="h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

      {/* 头部：当前状态概览 */}
      <div className="px-3 py-2.5 border-b border-border-subtle/30">
        <div className="flex items-center gap-2">
          {activeSession && (
            <>
              <StatusSymbol status={activeSession.status} size="sm" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-text-primary truncate">
                  {activeSession.title}
                </div>
                {/* 工作区按钮：点击展开下拉 */}
                <button
                  ref={workspaceButtonRef}
                  onClick={() => handleToggleDropdown(!isWorkspaceDropdownOpen)}
                  className={cn(
                    'flex items-center gap-1 mt-0.5 px-1 py-0.5 rounded',
                    'text-[10px] text-text-muted',
                    'hover:bg-background-hover/50 hover:text-text-secondary',
                    'transition-colors'
                  )}
                >
                  <FolderOpen className="w-2.5 h-2.5" />
                  <span className="truncate max-w-[100px]">{workspaceDisplayName}</span>
                  {totalContextCount > 1 && (
                    <span className="text-primary">+{totalContextCount - 1}</span>
                  )}
                  <ChevronDown className={cn(
                    'w-2.5 h-2.5 transition-transform',
                    isWorkspaceDropdownOpen && 'rotate-180'
                  )} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 会话列表 */}
      <div className="py-1.5">
        <div className="max-h-52 overflow-y-auto custom-scrollbar">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                'group relative mx-1.5 flex items-center gap-2 px-2 py-1.5 rounded-lg',
                'text-xs transition-all duration-150',
                session.isActive
                  ? 'bg-primary/10 border border-primary/15'
                  : 'hover:bg-background-hover/50 border border-transparent'
              )}
            >
              {/* 活跃指示条 */}
              {session.isActive && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-primary rounded-full shadow-[0_0_6px_rgba(59,130,246,0.4)]" />
              )}

              {/* 状态符号 */}
              <StatusSymbol status={session.status} size="sm" />

              {/* 会话名 */}
              <button
                onClick={() => onSwitchSession(session.id)}
                className="flex-1 min-w-0 text-left"
              >
                <span className={cn(
                  'truncate block',
                  session.isActive ? 'text-primary font-medium' : 'text-text-secondary'
                )}>
                  {session.title}
                </span>
              </button>

              {/* 运行中 */}
              {session.status === 'running' && (
                <Loader2 className="w-3 h-3 animate-spin text-success shrink-0" />
              )}

              {/* 删除按钮 */}
              {session.canDelete && (
                <button
                  onClick={() => onDeleteSession(session.id)}
                  className={cn(
                    'opacity-0 group-hover:opacity-100 p-0.5 rounded',
                    'text-text-muted hover:text-danger hover:bg-danger/10',
                    'transition-all shrink-0'
                  )}
                  title="关闭"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 底部：操作区 */}
      <div className="px-2 pb-2 pt-1 border-t border-border-subtle/20">
        {/* 新建会话 */}
        <button
          onClick={onCreateSession}
          className={cn(
            'w-full px-2 py-1.5 rounded-lg',
            'border border-dashed border-border-subtle/50',
            'text-[11px] text-text-muted',
            'hover:bg-background-hover/30 hover:text-text-secondary hover:border-border/30',
            'transition-all duration-150',
            'flex items-center justify-center gap-1'
          )}
        >
          <Plus className="w-3 h-3" />
          <span>New Session</span>
        </button>

        {/* 快捷操作行 */}
        <div className="flex items-center justify-center gap-1 mt-1.5">
          {onExport && (
            <button
              onClick={onExport}
              disabled={isExporting}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded',
                'text-[10px] text-text-tertiary',
                'hover:bg-background-hover/50 hover:text-text-secondary',
                'transition-colors',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              {isExporting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Download className="w-3 h-3" />
              )}
              <span>导出</span>
            </button>
          )}
          {onOpenHistory && (
            <button
              onClick={onOpenHistory}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded',
                'text-[10px] text-text-tertiary',
                'hover:bg-background-hover/50 hover:text-text-secondary',
                'transition-colors'
              )}
            >
              <Clock className="w-3 h-3" />
              <span>历史</span>
            </button>
          )}
        </div>
      </div>

      {/* 工作区下拉菜单 - Portal */}
      {isWorkspaceDropdownOpen && createPortal(
        <WorkspaceDropdown
          sessionId={activeSession?.id || null}
          workspaces={sortedWorkspaces}
          currentWorkspaceId={workspace?.id || null}
          contextWorkspaceIds={contextWorkspaceIds}
          isLocked={isWorkspaceLocked}
          position={dropdownPosition}
          onSelect={onSwitchWorkspace}
          onToggleContext={onToggleContextWorkspace}
          onClose={() => handleToggleDropdown(false)}
        />,
        document.body
      )}
    </div>
  )
})

// ============================================================================
// WorkspaceDropdown - 工作区下拉菜单
// ============================================================================

interface WorkspaceDropdownProps {
  sessionId: string | null
  workspaces: QuickWorkspaceInfo[]
  currentWorkspaceId: string | null
  contextWorkspaceIds: string[]
  isLocked: boolean
  position: { top: number; left: number }
  onSelect: (workspaceId: string) => void
  onToggleContext: (workspaceId: string) => void
  onClose: () => void
}

const WorkspaceDropdown = memo(function WorkspaceDropdown({
  sessionId,
  workspaces,
  currentWorkspaceId,
  contextWorkspaceIds,
  isLocked,
  position,
  onSelect,
  onToggleContext,
  onClose: _onClose,
}: WorkspaceDropdownProps) {
  // 新建工作区弹窗状态
  const [showCreateModal, setShowCreateModal] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // 不使用 mouseLeave 关闭，因为 Portal 渲染的元素刚出现时会误触发 mouseLeave
  // 改用点击外部关闭 + 用户主动操作后关闭

  // 切换主工作区（带验证）
  const handleSetMain = (workspaceId: string) => {
    if (isLocked || !sessionId) return
    onSelect(workspaceId)
  }

  // 切换关联工作区（带验证）
  const handleToggleContext = (workspaceId: string) => {
    if (!sessionId) return
    onToggleContext(workspaceId)
  }

  return (
    <>
      {/* 下拉面板 */}
      <div
        ref={dropdownRef}
        data-workspace-dropdown
        style={{
          position: 'fixed',
          top: position.top,
          left: position.left,
          width: 200,
        }}
        className={cn(
          'z-50 bg-background-elevated border border-border rounded-xl',
          'shadow-xl overflow-hidden',
          'animate-in fade-in-0 zoom-in-95 duration-150'
        )}
      >
        {/* 锁定提示 */}
        {isLocked && (
          <div className="px-2.5 py-1.5 bg-warning/10 border-b border-border-subtle flex items-center gap-1.5 text-[10px] text-warning">
            <Lock className="w-3 h-3" />
            <span>创建时已指定主工作区，不可修改</span>
          </div>
        )}

        {/* 工作区列表 */}
        <div className="max-h-48 overflow-y-auto">
          {workspaces.length === 0 ? (
            <div className="py-3 text-center text-xs text-text-tertiary">
              暂无工作区
            </div>
          ) : (
            workspaces.map((ws) => {
              const isCurrent = ws.id === currentWorkspaceId
              const isContext = contextWorkspaceIds.includes(ws.id)

              return (
                <div
                  key={ws.id}
                  className={cn(
                    'group relative flex items-center',
                    isCurrent && (isLocked ? 'bg-primary/5 opacity-80' : 'bg-primary/5')
                  )}
                >
                  {/* 当前工作区左侧指示条 */}
                  {isCurrent && (
                    <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary" />
                  )}

                  {/* 锁定图标 */}
                  {isCurrent && isLocked && (
                    <div className="px-2">
                      <Lock className="w-3 h-3 text-text-muted" />
                    </div>
                  )}

                  {/* 工作区信息 */}
                  <button
                    onClick={() => handleSetMain(ws.id)}
                    disabled={isLocked && isCurrent}
                    className={cn(
                      'flex-1 text-left px-2.5 py-1.5 text-xs transition-colors',
                      isCurrent
                        ? 'text-primary'
                        : isLocked
                          ? 'text-text-tertiary cursor-not-allowed'
                          : 'text-text-secondary hover:text-text-primary hover:bg-background-hover',
                      isLocked && isCurrent && 'cursor-not-allowed'
                    )}
                  >
                    <div className="font-medium truncate flex items-center gap-1.5">
                      {isCurrent && !isLocked && (
                        <span className="w-1 h-1 rounded-full bg-primary shrink-0" />
                      )}
                      {ws.name}
                    </div>
                  </button>

                  {/* 主标签 */}
                  {isCurrent && (
                    <span className="px-1.5 text-[10px] text-primary">主</span>
                  )}

                  {/* 关联按钮（非当前主工作区时显示） */}
                  {!isCurrent && workspaces.length > 1 && (
                    <button
                      onClick={() => handleToggleContext(ws.id)}
                      className={cn(
                        'p-1 rounded transition-colors shrink-0',
                        isContext
                          ? 'text-primary bg-primary/10'
                          : 'text-text-tertiary hover:text-primary hover:bg-background-hover opacity-0 group-hover:opacity-100'
                      )}
                      title={isContext ? '移除关联' : '添加关联'}
                    >
                      <Check className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* 分割线 */}
        <div className="border-t border-border-subtle" />

        {/* 新增工作区 */}
        <button
          onClick={() => setShowCreateModal(true)}
          className={cn(
            'w-full flex items-center gap-2 px-3 py-1.5 text-xs',
            'text-text-secondary hover:text-text-primary hover:bg-background-hover',
            'transition-colors'
          )}
        >
          <FolderPlus className="w-3.5 h-3.5 text-text-muted" />
          <span>新增工作区</span>
        </button>

        {/* 新建工作区弹窗 */}
        {showCreateModal && (
          <CreateWorkspaceModal onClose={() => setShowCreateModal(false)} />
        )}
      </div>
    </>
  )
})
