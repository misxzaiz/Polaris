/**
 * WorkspaceMenu - 工作区选择下拉菜单
 *
 * 显示所有可用工作区，点击后切换当前会话的工作区
 *
 * 简化版本：
 * - 项目会话：工作区固定，不可切换
 * - 自由会话：点击即切换为临时工作区
 */

import { cn } from '@/utils/cn'
import { Check, Plus, Settings, Lock } from 'lucide-react'
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

  // 获取当前会话
  const session = sessions.get(sessionId)

  // 获取会话当前有效工作区
  const effectiveWorkspaceId = session
    ? getSessionEffectiveWorkspace(session, currentWorkspaceId)
    : currentWorkspaceId

  // 是否为项目会话（工作区固定）
  const isProjectSession = session?.type === 'project'

  // 点击工作区项
  const handleWorkspaceClick = (workspaceId: string) => {
    if (isProjectSession) {
      // 项目会话不允许切换工作区
      return
    }

    // 自由会话：临时切换工作区
    switchSessionWorkspace(sessionId, workspaceId, 'temporary')
    onClose()
  }

  // 显示工作区列表
  return (
    <div className="w-[240px] py-2 bg-background-elevated border border-border rounded-xl shadow-lg">
      {/* 工作区列表 */}
      <div className="px-2 mb-2">
        <div className="text-xs font-medium text-text-tertiary px-1 mb-1.5">
          {isProjectSession ? '项目工作区' : '选择工作区'}
        </div>

        {workspaces.length === 0 ? (
          <div className="py-4 text-center text-sm text-text-tertiary">
            暂无工作区
          </div>
        ) : (
          <div className="space-y-1">
            {workspaces.map((workspace) => {
              const isCurrent = workspace.id === effectiveWorkspaceId

              return (
                <button
                  key={workspace.id}
                  onClick={() => handleWorkspaceClick(workspace.id)}
                  disabled={isProjectSession && !isCurrent}
                  className={cn(
                    'w-full px-3 py-2 rounded-lg text-left transition-colors',
                    'flex items-center gap-2',
                    isCurrent
                      ? 'bg-primary/10 border border-primary/20'
                      : 'hover:bg-background-hover',
                    isProjectSession && !isCurrent && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  {/* 选中标记 */}
                  <div className="w-4 h-4 flex items-center justify-center shrink-0">
                    {isCurrent && (
                      <Check className="w-3.5 h-3.5 text-primary" />
                    )}
                    {isProjectSession && !isCurrent && (
                      <Lock className="w-3 h-3 text-text-tertiary" />
                    )}
                  </div>

                  {/* 工作区名称 */}
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

        {isProjectSession && (
          <div className="mt-2 px-1 text-xs text-text-tertiary">
            项目会话的工作区固定，如需切换请创建新会话
          </div>
        )}
      </div>

      {/* 分割线 */}
      <div className="mx-2 my-1 border-t border-border" />

      {/* 底部操作按钮 */}
      <div className="px-2 space-y-1">
        <button
          onClick={() => {
            // TODO: 打开添加关联工作区对话框
            console.log('添加关联工作区 - 待实现')
            onClose()
          }}
          className={cn(
            'w-full flex items-center gap-2 px-3 py-2 rounded-lg',
            'text-sm text-text-secondary hover:text-text-primary',
            'hover:bg-background-hover transition-colors'
          )}
        >
          <Plus className="w-4 h-4" />
          添加关联工作区
        </button>

        <button
          onClick={() => {
            // TODO: 打开工作区管理面板
            console.log('工作区管理 - 待实现')
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