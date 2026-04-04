/**
 * WorkspaceMenu - 会话工作区选择下拉菜单
 *
 * 显示所有可用工作区，支持主工作区切换和关联工作区管理
 *
 * 工作区锁定规则：
 * - 主工作区在开始对话后锁定（workspaceLocked: true）
 * - 关联工作区可随时添加/移除
 *
 * UI 设计：
 * - 顶部标题行 + 新增按钮
 * - 工作区列表（点击切换主工作区，右侧按钮添加/移除关联）
 * - 底部关联状态汇总
 */

import { useState, useRef, useEffect } from 'react'
import { cn } from '@/utils/cn'
import { Check, Plus, Lock, X, Link } from 'lucide-react'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useSessionStore, getSessionEffectiveWorkspace } from '@/stores/sessionStore'
import { CreateWorkspaceModal } from '@/components/Workspace/CreateWorkspaceModal'

interface WorkspaceMenuProps {
  sessionId: string
  onClose: () => void
}

export function WorkspaceMenu({ sessionId, onClose }: WorkspaceMenuProps) {
  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId)
  const sessions = useSessionStore((state) => state.sessions)
  const switchSessionWorkspace = useSessionStore((state) => state.switchSessionWorkspace)
  const addContextWorkspace = useSessionStore((state) => state.addContextWorkspace)
  const removeContextWorkspace = useSessionStore((state) => state.removeContextWorkspace)

  // 新增工作区弹窗状态
  const [showCreateModal, setShowCreateModal] = useState(false)

  // 点击外部关闭
  const menuRef = useRef<HTMLDivElement>(null)
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
  const session = sessions.get(sessionId)

  // 获取会话当前有效工作区
  const effectiveWorkspaceId = session
    ? getSessionEffectiveWorkspace(session, currentWorkspaceId)
    : currentWorkspaceId

  // 使用 workspaceLocked 判断工作区是否锁定
  const isWorkspaceLocked = session?.workspaceLocked ?? (session?.type === 'project')
  const contextWorkspaceIds = session?.contextWorkspaceIds || []

  // 点击主工作区项（不关闭面板）
  const handleWorkspaceClick = (workspaceId: string) => {
    if (isWorkspaceLocked) {
      return
    }
    switchSessionWorkspace(sessionId, workspaceId, 'temporary')
    // 不关闭面板，用户可能还要操作关联工作区
  }

  // 切换关联工作区
  const handleToggleContext = (workspaceId: string) => {
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

  return (
    <div ref={menuRef} className="w-64 bg-background-elevated border border-border rounded-xl shadow-lg overflow-hidden">
      {/* 顶部标题行 */}
      <div className="px-3 py-2 text-xs font-medium text-text-tertiary border-b border-border-subtle flex items-center justify-between">
        <span className="flex items-center gap-1">
          {isWorkspaceLocked && <Lock className="w-3 h-3 text-amber-500" />}
          会话工作区
        </span>
        <button
          onClick={() => setShowCreateModal(true)}
          className="text-primary hover:text-primary-hover transition-colors"
        >
          + 新增
        </button>
      </div>

      {/* 工作区列表 */}
      <div className="max-h-48 overflow-y-auto">
        {workspaces.length === 0 ? (
          <div className="py-4 text-center text-sm text-text-tertiary">
            暂无工作区
          </div>
        ) : (
          workspaces.map((workspace) => {
            const isCurrent = workspace.id === effectiveWorkspaceId
            const isContext = contextWorkspaceIds.includes(workspace.id)
            const isDisabled = isWorkspaceLocked && !isCurrent

            return (
              <div
                key={workspace.id}
                className={cn(
                  'group relative flex items-center',
                  isCurrent && 'bg-primary/10'
                )}
              >
                {/* 当前工作区左侧指示条 */}
                {isCurrent && (
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary" />
                )}

                {/* 工作区名称和路径 */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleWorkspaceClick(workspace.id)
                  }}
                  disabled={isDisabled}
                  className={cn(
                    'flex-1 text-left px-3 py-2 text-sm transition-colors',
                    isCurrent
                      ? 'text-primary'
                      : 'text-text-secondary hover:text-text-primary hover:bg-background-hover',
                    isDisabled && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <div className="pr-16 font-medium truncate flex items-center gap-2">
                    {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
                    {workspace.name}
                  </div>
                  <div className="text-xs truncate text-text-tertiary">
                    {workspace.path}
                  </div>
                </button>

                {/* 关联按钮（所有工作区都显示，除了当前主工作区） */}
                {workspaces.length > 1 && !isCurrent && (
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
          关联工作区 ({contextWorkspaceIds.length + 1})
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
}
