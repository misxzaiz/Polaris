/**
 * QuickSwitchPanel - 快速切换面板主组件
 *
 * 右侧悬停触发的会话快速切换面板
 * 核心功能：快速切换会话
 */

import { memo, useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { cn } from '@/utils/cn'
import { QuickSwitchTrigger } from './QuickSwitchTrigger'
import { QuickSwitchContent } from './QuickSwitchContent'
import type { QuickSwitchPanelProps, QuickSessionInfo, QuickWorkspaceInfo } from './types'
import type { SessionStatus } from '@/types/session'
import {
  useSessionMetadataList,
  useActiveSessionId,
  useSessionManagerActions,
  useActiveSessionMessages,
} from '@/stores/conversationStore'
import { useWorkspaceStore, useViewStore } from '@/stores'
import { exportToMarkdown, generateFileName } from '@/services/chatExport'
import * as tauri from '@/services/tauri'
import { createLogger } from '@/utils/logger'

const log = createLogger('QuickSwitchPanel')

/** 展开延迟（毫秒） */
const SHOW_DELAY = 0

/** 关闭延迟（毫秒） */
const HIDE_DELAY = 150

export const QuickSwitchPanel = memo(function QuickSwitchPanel({
  className,
}: QuickSwitchPanelProps) {
  // 面板可见状态
  const [isPanelVisible, setIsPanelVisible] = useState(false)

  // 工作区下拉是否打开的 ref（同步更新，避免面板关闭）
  const workspaceDropdownOpenRef = useRef(false)

  // 使用 ref 管理悬停状态，避免闭包陷阱
  const isHoveringTriggerRef = useRef(false)
  const isHoveringPanelRef = useRef(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 会话数据
  const sessions = useSessionMetadataList()
  const activeSessionId = useActiveSessionId()
  const { createSession, deleteSession, switchSession } = useSessionManagerActions()
  const { messages } = useActiveSessionMessages()

  // 工作区数据
  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId)

  // 视图控制
  const { toggleSessionHistory } = useViewStore()

  // 清除所有定时器
  const clearTimers = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current)
      showTimerRef.current = null
    }
  }, [])

  // 显示面板（带延迟）
  const scheduleShow = useCallback(() => {
    clearTimers()
    showTimerRef.current = setTimeout(() => {
      setIsPanelVisible(true)
    }, SHOW_DELAY)
  }, [clearTimers])

  // 隐藏面板（带延迟）
  const scheduleHide = useCallback(() => {
    clearTimers()
    hideTimerRef.current = setTimeout(() => {
      // 下拉打开时不关闭面板（使用 ref，同步更新）
      if (workspaceDropdownOpenRef.current) return
      if (!isHoveringTriggerRef.current && !isHoveringPanelRef.current) {
        setIsPanelVisible(false)
      }
    }, HIDE_DELAY)
  }, [clearTimers])

  // 组件卸载时清理
  useEffect(() => {
    return () => clearTimers()
  }, [clearTimers])

  // 触发器悬停处理
  const handleTriggerMouseEnter = useCallback(() => {
    isHoveringTriggerRef.current = true
    scheduleShow()
  }, [scheduleShow])

  const handleTriggerMouseLeave = useCallback(() => {
    isHoveringTriggerRef.current = false
    scheduleHide()
  }, [scheduleHide])

  // 面板悬停处理
  const handlePanelMouseEnter = useCallback(() => {
    isHoveringPanelRef.current = true
    clearTimers()
  }, [clearTimers])

  const handlePanelMouseLeave = useCallback(() => {
    isHoveringPanelRef.current = false
    scheduleHide()
  }, [scheduleHide])

  // 会话切换
  const handleSwitchSession = useCallback((sessionId: string) => {
    switchSession(sessionId)
    // 切换后保持面板展开，用户可能需要连续切换
  }, [switchSession])

  // 删除会话
  const handleDeleteSession = useCallback((sessionId: string) => {
    deleteSession(sessionId)
  }, [deleteSession])

  // 新建会话
  const handleCreateSession = useCallback(() => {
    createSession({
      type: 'free',
      workspaceId: currentWorkspaceId || undefined,
    })
  }, [createSession, currentWorkspaceId])

  // 计算会话列表数据
  const sessionList = useMemo<QuickSessionInfo[]>(() => {
    // 过滤静默会话
    const visibleSessions = sessions.filter(s => !s.silentMode)
    return visibleSessions.map(session => ({
      id: session.id,
      title: session.title,
      status: mapSessionStatus(session.status),
      isActive: session.id === activeSessionId,
      canDelete: session.id !== activeSessionId && visibleSessions.length > 1,
    }))
  }, [sessions, activeSessionId])

  // 计算当前工作区信息
  const workspaceInfo = useMemo<QuickWorkspaceInfo | null>(() => {
    const activeSession = sessions.find(s => s.id === activeSessionId)
    if (!activeSession?.workspaceId) return null
    const workspace = workspaces.find(w => w.id === activeSession.workspaceId)
    if (!workspace) return null
    return {
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
      isMain: true,
      isContext: false,
      contextCount: activeSession.contextWorkspaceIds?.length || 0,
    }
  }, [sessions, activeSessionId, workspaces])

  // 计算工作区列表数据
  const workspaceList = useMemo<QuickWorkspaceInfo[]>(() => {
    const activeSession = sessions.find(s => s.id === activeSessionId)
    const mainWorkspaceId = activeSession?.workspaceId
    const contextIds = activeSession?.contextWorkspaceIds || []

    return workspaces.map(w => ({
      id: w.id,
      name: w.name,
      path: w.path,
      isMain: w.id === mainWorkspaceId,
      isContext: contextIds.includes(w.id),
    }))
  }, [sessions, activeSessionId, workspaces])

  // 当前会话的关联工作区ID列表
  const contextWorkspaceIds = useMemo(() => {
    const activeSession = sessions.find(s => s.id === activeSessionId)
    return activeSession?.contextWorkspaceIds || []
  }, [sessions, activeSessionId])

  // 当前会话是否锁定
  const isWorkspaceLocked = useMemo(() => {
    const activeSession = sessions.find(s => s.id === activeSessionId)
    return activeSession?.workspaceLocked || false
  }, [sessions, activeSessionId])

  // 工作区操作
  const { updateSessionWorkspace, addContextWorkspace, removeContextWorkspace } = useSessionManagerActions()

  // 切换主工作区
  const handleSwitchWorkspace = useCallback((workspaceId: string) => {
    if (!activeSessionId || isWorkspaceLocked) return
    updateSessionWorkspace(activeSessionId, workspaceId)
  }, [activeSessionId, isWorkspaceLocked, updateSessionWorkspace])

  // 切换关联工作区
  const handleToggleContextWorkspace = useCallback((workspaceId: string) => {
    if (!activeSessionId) return
    if (contextWorkspaceIds.includes(workspaceId)) {
      removeContextWorkspace(activeSessionId, workspaceId)
    } else {
      addContextWorkspace(activeSessionId, workspaceId)
    }
  }, [activeSessionId, contextWorkspaceIds, addContextWorkspace, removeContextWorkspace])

  // 导出聊天
  const [isExporting, setIsExporting] = useState(false)
  const handleExport = useCallback(async () => {
    if (messages.length === 0 || isExporting) return

    setIsExporting(true)
    try {
      const content = exportToMarkdown(messages)
      const fileName = generateFileName('md')
      const filePath = await tauri.saveChatToFile(content, fileName)

      if (filePath) {
        log.info('导出聊天成功', { path: filePath })
      }
    } catch (error) {
      log.error(
        '导出聊天失败',
        error instanceof Error ? error : new Error(String(error))
      )
    } finally {
      setIsExporting(false)
    }
  }, [messages, isExporting])

  // 打开历史会话
  const handleOpenHistory = useCallback(() => {
    toggleSessionHistory()
  }, [toggleSessionHistory])

  // 获取当前会话状态
  const currentStatus = useMemo<SessionStatus>(() => {
    const activeSession = sessions.find(s => s.id === activeSessionId)
    return activeSession ? mapSessionStatus(activeSession.status) : 'idle'
  }, [sessions, activeSessionId])

  // 无会话时不显示
  if (sessionList.length === 0) {
    return null
  }

  return (
    <div className={cn('fixed right-0 top-0 bottom-0 pointer-events-none z-20', className)}>
      {/* 触发器容器 */}
      <div className="absolute right-0 top-[45%] -translate-y-1/2 pointer-events-auto">
        <QuickSwitchTrigger
          status={currentStatus}
          isHovering={isPanelVisible}
          onMouseEnter={handleTriggerMouseEnter}
          onMouseLeave={handleTriggerMouseLeave}
        />

        {/* 面板 */}
        {isPanelVisible && (
          <div className="absolute right-10 top-0">
            <QuickSwitchContent
              sessions={sessionList}
              workspace={workspaceInfo}
              workspaces={workspaceList}
              contextWorkspaceIds={contextWorkspaceIds}
              isWorkspaceLocked={isWorkspaceLocked}
              onSwitchSession={handleSwitchSession}
              onDeleteSession={handleDeleteSession}
              onCreateSession={handleCreateSession}
              onSwitchWorkspace={handleSwitchWorkspace}
              onToggleContextWorkspace={handleToggleContextWorkspace}
              onExport={messages.length > 0 ? handleExport : undefined}
              isExporting={isExporting}
              onOpenHistory={handleOpenHistory}
              workspaceDropdownOpenRef={workspaceDropdownOpenRef}
              onMouseEnter={handlePanelMouseEnter}
              onMouseLeave={handlePanelMouseLeave}
            />
          </div>
        )}
      </div>
    </div>
  )
})

// 会话状态映射
function mapSessionStatus(status: string): SessionStatus {
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
