/**
 * WorkspaceMenu - 工作区选择下拉菜单
 *
 * 显示所有可用工作区，支持主工作区和关联工作区管理
 *
 * 工作区锁定规则：
 * - 主工作区在开始对话后锁定（workspaceLocked: true）
 * - 关联工作区可随时添加/移除
 */

import { cn } from '@/utils/cn'
import { Check, Plus, Settings, Lock, X } from 'lucide-react'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useSessionStore, getSessionEffectiveWorkspace } from '@/stores/sessionStore'

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

  // 获取当前会话
  const session = sessions.get(sessionId)

  // 获取会话当前有效工作区
  const effectiveWorkspaceId = session
    ? getSessionEffectiveWorkspace(session, currentWorkspaceId)
    : currentWorkspaceId

  // 使用 workspaceLocked 判断工作区是否锁定
  const isWorkspaceLocked = session?.workspaceLocked ?? (session?.type === 'project')
  const contextWorkspaceIds = session?.contextWorkspaceIds || []

  // 点击主工作区项
  const handleWorkspaceClick = (workspaceId: string) => {
    if (isWorkspaceLocked) {
      // 工作区已锁定，不允许切换
      return
    }

    // 自由会话：临时切换工作区
    switchSessionWorkspace(sessionId, workspaceId, 'temporary')
    onClose()
  }

  // 添加关联工作区
  const handleAddContextWorkspace = (workspaceId: string) => {
    addContextWorkspace(sessionId, workspaceId)
  }

  // 移除关联工作区
  const handleRemoveContextWorkspace = (workspaceId: string) => {
    removeContextWorkspace(sessionId, workspaceId)
  }

  // 显示工作区列表
  return (
    <div className="w-[280px] max-h-[400px] overflow-y-auto py-2 bg-background-elevated border border-border rounded-xl shadow-lg">
      {/* 主工作区 */}
      <div className="px-2 mb-2">
        <div className="text-xs font-medium text-text-tertiary px-1 mb-1.5 flex items-center gap-1">
          主工作区
          {isWorkspaceLocked && (
            <span className="flex items-center gap-0.5 text-amber-500">
              <Lock className="w-3 h-3" />
              已锁定
            </span>
          )}
        </div>

        {workspaces.length === 0 ? (
          <div className="py-4 text-center text-sm text-text-tertiary">
            暂无工作区
          </div>
        ) : (
          <div className="space-y-1">
            {workspaces.map((workspace) => {
              const isCurrent = workspace.id === effectiveWorkspaceId
              const isDisabled = isWorkspaceLocked && !isCurrent

              return (
                <button
                  key={workspace.id}
                  onClick={() => handleWorkspaceClick(workspace.id)}
                  disabled={isDisabled}
                  className={cn(
                    'w-full px-3 py-2 rounded-lg text-left transition-colors',
                    'flex items-center gap-2',
                    isCurrent
                      ? 'bg-primary/10 border border-primary/20'
                      : 'hover:bg-background-hover',
                    isDisabled && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <div className="w-4 h-4 flex items-center justify-center shrink-0">
                    {isCurrent && <Check className="w-3.5 h-3.5 text-primary" />}
                    {isDisabled && <Lock className="w-3 h-3 text-text-tertiary" />}
                  </div>

                  <span className={cn(
                    'flex-1 text-sm truncate',
                    isCurrent ? 'text-primary font-medium' : 'text-text-primary'
                  )}>
                    {workspace.name}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {isWorkspaceLocked && (
          <div className="mt-2 px-1 text-xs text-text-tertiary">
            开始对话后主工作区不可修改
          </div>
        )}
      </div>

      {/* 分割线 */}
      <div className="mx-2 my-2 border-t border-border" />

      {/* 关联工作区 */}
      <div className="px-2 mb-2">
        <div className="text-xs font-medium text-text-tertiary px-1 mb-1.5">
          关联工作区
        </div>

        <div className="space-y-1">
          {/* 已关联的工作区 */}
          {contextWorkspaceIds.map((contextId) => {
            const workspace = workspaces.find(w => w.id === contextId)
            if (!workspace) return null

            return (
              <button
                key={contextId}
                onClick={() => handleRemoveContextWorkspace(contextId)}
                className={cn(
                  'w-full px-3 py-2 rounded-lg text-left transition-colors',
                  'flex items-center gap-2',
                  'bg-green-500/10 border border-green-500/20',
                  'hover:bg-red-500/10 hover:border-red-500/20'
                )}
              >
                <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />
                <span className="flex-1 text-sm truncate text-text-primary">
                  {workspace.name}
                </span>
                <X className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
              </button>
            )
          })}

          {/* 可添加的工作区 */}
          {workspaces
            .filter(w => w.id !== effectiveWorkspaceId && !contextWorkspaceIds.includes(w.id))
            .map((workspace) => (
              <button
                key={workspace.id}
                onClick={() => handleAddContextWorkspace(workspace.id)}
                className={cn(
                  'w-full px-3 py-2 rounded-lg text-left transition-colors',
                  'flex items-center gap-2',
                  'hover:bg-background-hover'
                )}
              >
                <Plus className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
                <span className="flex-1 text-sm truncate text-text-secondary">
                  {workspace.name}
                </span>
                <span className="text-xs text-blue-500">添加</span>
              </button>
            ))}

          {/* 如果没有可添加的工作区 */}
          {workspaces.filter(w => w.id !== effectiveWorkspaceId && !contextWorkspaceIds.includes(w.id)).length === 0 && contextWorkspaceIds.length === 0 && (
            <div className="py-2 text-center text-xs text-text-tertiary">
              暂无其他工作区可关联
            </div>
          )}
        </div>
      </div>

      {/* 底部操作 */}
      <div className="mx-2 my-2 border-t border-border" />
      <div className="px-2">
        <button
          onClick={() => {
            // TODO: 打开工作区管理
            onClose()
          }}
          className={cn(
            'w-full flex items-center gap-2 px-3 py-2 rounded-lg',
            'text-sm text-text-secondary hover:text-text-primary',
            'hover:bg-background-hover transition-colors'
          )}
        >
          <Settings className="w-4 h-4" />
          工作区管理
        </button>
      </div>
    </div>
  )
}