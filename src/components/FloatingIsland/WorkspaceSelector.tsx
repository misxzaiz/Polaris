/**
 * WorkspaceSelector - 工作区选择器组件
 *
 * 显示当前工作区和关联数量，点击展开下拉菜单
 */

import { memo, useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/utils/cn'
import { FolderOpen, ChevronDown, Lock, Check, X, Link } from 'lucide-react'
import {
  useSessionMetadataList,
  useActiveSessionId,
  useSessionManagerActions,
} from '@/stores/conversationStore/sessionStoreManager'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { CreateWorkspaceModal } from '@/components/Workspace/CreateWorkspaceModal'

interface WorkspaceSelectorProps {
  isOpen: boolean
  onToggle: () => void
  onClose: () => void
}

export const WorkspaceSelector = memo(function WorkspaceSelector({
  isOpen,
  onToggle,
  onClose,
}: WorkspaceSelectorProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)

  const sessions = useSessionMetadataList()
  const activeSessionId = useActiveSessionId()
  const workspaces = useWorkspaceStore((state) => state.workspaces)

  // 获取当前会话
  const activeSession = sessions.find(s => s.id === activeSessionId)

  // 获取工作区信息
  const currentWorkspace = activeSession?.workspaceId
    ? workspaces.find(w => w.id === activeSession.workspaceId)
    : null

  const contextCount = activeSession?.contextWorkspaceIds?.length || 0

  // 判断是否锁定（有消息时锁定）
  const isLocked = activeSession?.workspaceLocked || false

  return (
    <>
      {/* 工作区选择按钮 */}
      <button
        ref={buttonRef}
        onClick={onToggle}
        className={cn(
          'flex items-center gap-1.5 px-2 h-7 rounded-full',
          'hover:bg-background-hover transition-colors cursor-pointer',
          isOpen && 'bg-background-hover'
        )}
        title="工作区"
      >
        <FolderOpen className="w-4 h-4 text-text-muted" />

        {/* 工作区名称 */}
        <span className="text-xs text-text-secondary max-w-[80px] truncate">
          {currentWorkspace?.name || '设置工作区'}
        </span>

        {/* 关联数量徽章 */}
        {contextCount > 0 && (
          <span className="bg-primary/10 text-primary text-xs px-1 rounded">
            +{contextCount}
          </span>
        )}

        {/* 下拉箭头 */}
        <ChevronDown
          className={cn(
            'w-3 h-3 text-text-muted transition-transform duration-200',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      {/* 下拉面板 - Portal 渲染 */}
      {isOpen && createPortal(
        <WorkspaceDropdown
          sessionId={activeSessionId}
          currentWorkspaceId={activeSession?.workspaceId || null}
          contextWorkspaceIds={activeSession?.contextWorkspaceIds || []}
          isLocked={isLocked}
          onClose={onClose}
          anchorRef={buttonRef}
        />,
        document.body
      )}
    </>
  )
})

// ============================================================================
// WorkspaceDropdown - 工作区下拉面板
// ============================================================================

interface WorkspaceDropdownProps {
  sessionId: string | null
  currentWorkspaceId: string | null
  contextWorkspaceIds: string[]
  isLocked: boolean
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
}

const WorkspaceDropdown = memo(function WorkspaceDropdown({
  sessionId,
  currentWorkspaceId,
  contextWorkspaceIds,
  isLocked,
  onClose,
  anchorRef,
}: WorkspaceDropdownProps) {
  const dropdownRef = useRef<HTMLDivElement>(null)
  const { updateSessionWorkspace, addContextWorkspace, removeContextWorkspace } = useSessionManagerActions()
  const workspaces = useWorkspaceStore((state) => state.workspaces)

  // 新建工作区弹窗
  const [showCreateModal, setShowCreateModal] = useState(false)

  // 计算位置
  const [position, setPosition] = useState({ top: 0, left: 0 })

  useEffect(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect()
      setPosition({
        top: rect.bottom + 8,
        left: Math.max(8, rect.left - 100), // 确保不超出左边界
      })
    }
  }, [anchorRef])

  // 点击外部关闭
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  // 切换主工作区
  const handleSetMain = (workspaceId: string) => {
    if (isLocked || !sessionId) return
    updateSessionWorkspace(sessionId, workspaceId)
    // 不关闭面板，用户可能还要操作关联工作区
  }

  // 切换关联工作区
  const handleToggleContext = (workspaceId: string) => {
    if (!sessionId) return
    if (contextWorkspaceIds.includes(workspaceId)) {
      removeContextWorkspace(sessionId, workspaceId)
    } else {
      addContextWorkspace(sessionId, workspaceId)
    }
    // 不关闭面板
  }

  // 获取关联工作区列表
  const contextWorkspaces = workspaces.filter(w => contextWorkspaceIds.includes(w.id))
  const currentWorkspace = workspaces.find(w => w.id === currentWorkspaceId)

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
        data-floating-dropdown="workspace"
        style={{
          position: 'fixed',
          top: position.top,
          left: position.left,
          width: 280,
        }}
        className={cn(
          'z-50 bg-background-elevated border border-border rounded-xl',
          'shadow-xl overflow-hidden',
          'animate-in fade-in-0 zoom-in-95 duration-150'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="px-3 py-2 border-b border-border-subtle flex items-center justify-between">
          <span className="text-xs font-medium text-text-tertiary">工作区</span>
          <button
            onClick={() => setShowCreateModal(true)}
            className="text-xs text-primary hover:text-primary-hover transition-colors"
          >
            + 新增
          </button>
        </div>

        {/* 锁定提示 */}
        {isLocked && (
          <div className="px-3 py-2 bg-warning/10 border-b border-border-subtle flex items-center gap-2 text-xs text-warning">
            <Lock className="w-3.5 h-3.5" />
            <span>会话进行中，主工作区已锁定</span>
          </div>
        )}

        {/* 工作区列表 */}
        <div className="max-h-48 overflow-y-auto">
          {workspaces.length === 0 ? (
            <div className="py-4 text-center text-sm text-text-tertiary">
              暂无工作区
            </div>
          ) : (
            workspaces.map((workspace) => {
              const isCurrent = workspace.id === currentWorkspaceId
              const isContext = contextWorkspaceIds.includes(workspace.id)

              return (
                <div
                  key={workspace.id}
                  className={cn(
                    'group relative flex items-center',
                    isCurrent && (isLocked ? 'bg-primary/10 opacity-80' : 'bg-primary/10')
                  )}
                >
                  {/* 当前工作区左侧指示条 */}
                  {isCurrent && (
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary" />
                  )}

                  {/* 锁定图标 */}
                  {isCurrent && isLocked && (
                    <div className="px-2">
                      <Lock className="w-3.5 h-3.5 text-text-muted" />
                    </div>
                  )}

                  {/* 工作区信息 */}
                  <button
                    onClick={() => !isLocked && handleSetMain(workspace.id)}
                    disabled={isLocked && isCurrent}
                    className={cn(
                      'flex-1 text-left px-3 py-2 text-sm transition-colors',
                      isCurrent
                        ? 'text-primary'
                        : isLocked
                          ? 'text-text-secondary cursor-not-allowed'
                          : 'text-text-secondary hover:text-text-primary hover:bg-background-hover',
                      isLocked && isCurrent && 'cursor-not-allowed'
                    )}
                  >
                    <div className="font-medium truncate flex items-center gap-2">
                      {isCurrent && !isLocked && (
                        <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                      )}
                      {workspace.name}
                    </div>
                    <div className="text-xs truncate text-text-tertiary">
                      {workspace.path}
                    </div>
                  </button>

                  {/* 主标签 */}
                  {isCurrent && (
                    <span className="px-2 text-xs text-primary">主</span>
                  )}

                  {/* 关联按钮（非当前主工作区时显示） */}
                  {!isCurrent && workspaces.length > 1 && (
                    <button
                      onClick={() => handleToggleContext(workspace.id)}
                      className={cn(
                        'p-1.5 rounded transition-colors',
                        isContext
                          ? 'text-primary bg-primary/10'
                          : 'text-text-tertiary hover:text-primary hover:bg-background-hover opacity-0 group-hover:opacity-100'
                      )}
                      title={isContext ? '移除关联' : '添加关联'}
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* 关联工作区汇总 */}
        {(contextWorkspaces.length > 0 || currentWorkspace) && (
          <div className="border-t border-border-subtle">
            <div className="px-3 py-2 text-xs text-text-tertiary flex items-center gap-1">
              <Link className="w-3 h-3" />
              关联工作区 ({(contextWorkspaces.length || 0) + (currentWorkspace ? 1 : 0)})
              <span className="text-text-muted">· AI 可访问这些文件</span>
            </div>

            <div className="max-h-32 overflow-y-auto pb-1">
              {/* 主工作区 */}
              {currentWorkspace && (
                <div className="flex items-center px-3 py-1.5 text-sm text-text-secondary bg-primary/5">
                  <span className="w-2 h-2 rounded-full bg-primary mr-2" />
                  <span className="flex-1 truncate">{currentWorkspace.name}</span>
                  <span className="text-xs text-text-tertiary mr-2">主</span>
                </div>
              )}

              {/* 关联工作区 */}
              {contextWorkspaces.map((workspace) => (
                <div
                  key={workspace.id}
                  className="group flex items-center px-3 py-1.5 text-sm text-text-secondary hover:bg-background-hover"
                >
                  <span className="w-2 h-2 rounded-full bg-primary/50 mr-2" />
                  <span className="flex-1 truncate">{workspace.name}</span>
                  <button
                    onClick={() => handleToggleContext(workspace.id)}
                    className="p-1 rounded text-text-tertiary hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity"
                    title="移除关联"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 新建工作区弹窗 */}
        {showCreateModal && (
          <CreateWorkspaceModal onClose={() => setShowCreateModal(false)} />
        )}
      </div>
    </>
  )
})