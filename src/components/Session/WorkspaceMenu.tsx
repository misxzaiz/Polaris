/**
 * WorkspaceMenu - 会话工作区选择下拉菜单
 *
 * 显示所有可用工作区，支持主工作区切换和关联工作区管理
 *
 * UI 设计：
 * - 顶部标题行 + 新增按钮
 * - 锁定提示（如有消息）
 * - 工作区列表（点击切换主工作区，右侧按钮添加/移除关联）
 * - 底部关联状态汇总
 */

import { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils/cn'
import { Check, Plus, X, Link, Lock } from 'lucide-react'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useSessionMetadataList, useSessionManagerActions } from '@/stores/conversationStore/sessionStoreManager'
import { CreateWorkspaceModal } from '@/components/Workspace/CreateWorkspaceModal'
import { WorkspaceSearchInput, useWorkspaceFilter } from '@/components/Workspace/WorkspaceSearchInput'

interface WorkspaceMenuProps {
  sessionId: string
  anchorEl: HTMLElement | null
  onClose: () => void
}

export function WorkspaceMenu({ sessionId, anchorEl, onClose }: WorkspaceMenuProps) {
  const { t } = useTranslation('workspace')
  const workspacesRaw = useWorkspaceStore((state) => state.workspaces)
  const workspaces = useMemo(() =>
    workspacesRaw.slice().sort((a, b) =>
      new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime()
    ), [workspacesRaw]
  )
  const sessions = useSessionMetadataList()
  const { updateSessionWorkspace, addContextWorkspace, removeContextWorkspace } = useSessionManagerActions()

  // 新增工作区弹窗状态
  const [showCreateModal, setShowCreateModal] = useState(false)
  // 搜索状态
  const [searchQuery, setSearchQuery] = useState('')

  // 搜索过滤
  const filteredWorkspaces = useWorkspaceFilter(workspaces, searchQuery)

  // 菜单位置
  const [position, setPosition] = useState({ top: 0, left: 0 })

  // 点击外部关闭
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 计算菜单位置
    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect()
      setPosition({
        top: rect.bottom + 4, // 徽章下方 4px
        left: rect.left,
      })
    }
  }, [anchorEl])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [onClose])

  // 获取当前会话
  const session = sessions.find(s => s.id === sessionId)

  if (!session) {
    return null
  }

  const effectiveWorkspaceId = session.workspaceId
  const contextWorkspaceIds = session.contextWorkspaceIds || []
  const isLocked = session.workspaceLocked || false

  // 点击主工作区项（不关闭面板）
  const handleWorkspaceClick = (workspaceId: string) => {
    if (isLocked) return // 锁定时不允许切换
    console.log('[WorkspaceMenu] 切换工作区:', sessionId, workspaceId)
    updateSessionWorkspace(sessionId, workspaceId)
    // 不关闭面板，用户可能还要操作关联工作区
  }

  // 切换关联工作区
  const handleToggleContext = (workspaceId: string) => {
    console.log('[WorkspaceMenu] 切换关联工作区:', sessionId, workspaceId)
    if (contextWorkspaceIds.includes(workspaceId)) {
      removeContextWorkspace(sessionId, workspaceId)
    } else {
      addContextWorkspace(sessionId, workspaceId)
    }
    // 不关闭面板
  }

  // 获取当前主工作区
  const currentWorkspace = workspaces.find(w => w.id === effectiveWorkspaceId)

  // 获取关联工作区列表
  const contextWorkspaces = workspaces.filter(w => contextWorkspaceIds.includes(w.id))

  const menuContent = (
    <div
      ref={menuRef}
      className="fixed w-64 bg-background-elevated border border-border rounded-xl shadow-lg overflow-hidden z-50"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
    >
      {/* 顶部标题行 */}
      <div className="px-3 py-2 text-xs font-medium text-text-tertiary border-b border-border-subtle flex items-center justify-between">
        <span>会话工作区</span>
        <button
          onClick={() => setShowCreateModal(true)}
          className="text-primary hover:text-primary-hover transition-colors"
        >
          + 新增
        </button>
      </div>

      {/* 锁定提示 */}
      {isLocked && (
        <div className="px-3 py-2 bg-warning/10 border-b border-border-subtle flex items-center gap-2 text-xs text-warning">
          <Lock className="w-3.5 h-3.5" />
          <span>创建时已指定主工作区，不可修改</span>
        </div>
      )}

      {/* 搜索框 - 工作区超过3个时显示 */}
      {workspaces.length > 3 && (
        <div className="px-3 py-2 border-b border-border-subtle">
          <WorkspaceSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            autoFocus
          />
        </div>
      )}

      {/* 工作区列表 */}
      <div className="max-h-48 overflow-y-auto">
        {filteredWorkspaces.length === 0 ? (
          <div className="py-4 text-center text-sm text-text-tertiary">
            {t('search.noResults')}
          </div>
        ) : (
          filteredWorkspaces.map((workspace) => {
            const isCurrent = workspace.id === effectiveWorkspaceId
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

                {/* 工作区名称和路径 */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleWorkspaceClick(workspace.id)
                  }}
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
                  <div className="pr-16 font-medium truncate flex items-center gap-2">
                    {isCurrent && !isLocked && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
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

                {/* 关联按钮（所有工作区都显示，除了当前主工作区） */}
                {filteredWorkspaces.length > 1 && !isCurrent && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleToggleContext(workspace.id)
                    }}
                    className={cn(
                      'absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-colors',
                      isContext
                        ? 'text-primary bg-primary/10'
                        : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover opacity-0 group-hover:opacity-100'
                    )}
                    title={isContext ? '移除关联' : '添加关联'}
                  >
                    {isContext ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Plus className="w-3.5 h-3.5" />
                    )}
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* 关联工作区汇总 */}
      <div className="border-t border-border-subtle">
        <div className="px-3 py-2 text-xs text-text-tertiary flex items-center gap-1">
          <Link className="w-3 h-3" />
          关联工作区 ({contextWorkspaceIds.length})
        </div>

        {contextWorkspaces.length > 0 ? (
          <div className="max-h-32 overflow-y-auto">
            {/* 当前主工作区 */}
            {currentWorkspace && (
              <div className="group flex items-center px-3 py-1.5 text-sm text-text-secondary bg-primary/5">
                <span className="w-2 h-2 rounded-full bg-primary mr-2" />
                <span className="flex-1 truncate">{currentWorkspace.name}</span>
                <span className="text-xs text-text-tertiary mr-2">主</span>
              </div>
            )}
            {/* 已关联的工作区 */}
            {contextWorkspaces.map((workspace) => (
              <div
                key={workspace.id}
                className="group flex items-center px-3 py-1.5 text-sm text-text-secondary hover:bg-background-hover"
              >
                <span className="w-2 h-2 rounded-full bg-primary/50 mr-2" />
                <span className="flex-1 truncate">{workspace.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleToggleContext(workspace.id)
                  }}
                  className="p-1 rounded text-text-tertiary hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity"
                  title="移除关联"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-3 py-2 text-xs text-text-tertiary text-center">
            点击工作区右侧的 + 添加关联
          </div>
        )}
      </div>

      {/* 提示信息 */}
      {contextWorkspaces.length > 0 && (
        <div className="mx-2 my-2 p-2 bg-primary/5 border border-primary/20 rounded text-xs text-text-secondary">
          AI 可以访问关联工作区中的文件
        </div>
      )}

      {/* 新增工作区弹窗 */}
      {showCreateModal && (
        <CreateWorkspaceModal onClose={() => setShowCreateModal(false)} />
      )}
    </div>
  )

  return createPortal(menuContent, document.body)
}
