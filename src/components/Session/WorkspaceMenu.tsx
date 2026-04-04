/**
 * WorkspaceMenu - 工作区选择下拉菜单
 *
 * 显示所有可用工作区，支持主工作区和关联工作区管理
 *
 * 工作区锁定规则：
 * - 主工作区在开始对话后锁定（workspaceLocked: true）
 * - 关联工作区可随时添加/移除
 *
 * UX 优化：
 * - 搜索框置顶，快速筛选工作区
 * - 新增按钮在搜索框右侧，始终可见
 * - 列表高度限制 240px，超出滚动
 * - 底部关联管理入口
 */

import { useState, useRef, useEffect } from 'react'
import { cn } from '@/utils/cn'
import { Check, Plus, Lock, X, Link, Search } from 'lucide-react'
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

  // 搜索查询
  const [searchQuery, setSearchQuery] = useState('')
  // 新增工作区弹窗状态
  const [showCreateModal, setShowCreateModal] = useState(false)
  // 关联管理弹窗状态
  const [showContextModal, setShowContextModal] = useState(false)

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

  // 搜索筛选
  const filteredWorkspaces = workspaces.filter(w =>
    w.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    w.path.toLowerCase().includes(searchQuery.toLowerCase())
  )

  // 主工作区列表（排除已关联的）
  const mainWorkspaces = filteredWorkspaces.filter(w => !contextWorkspaceIds.includes(w.id))

  // 点击主工作区项
  const handleWorkspaceClick = (workspaceId: string) => {
    if (isWorkspaceLocked) {
      return
    }
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

  return (
    <div ref={menuRef} className="absolute top-full right-0 mt-1 z-50 w-[280px] bg-background-elevated border border-border rounded-xl shadow-lg">
      {/* 搜索区 */}
      <div className="p-2 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 px-3 py-1.5 bg-background-surface border border-border rounded-lg">
            <Search className="w-4 h-4 text-text-tertiary shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索工作区..."
              className="flex-1 bg-transparent border-none outline-none text-sm text-text-primary placeholder:text-text-tertiary"
              autoFocus
            />
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="w-8 h-8 flex items-center justify-center bg-primary hover:bg-primary-hover rounded-lg transition-colors"
            title="新增工作区"
          >
            <Plus className="w-4 h-4 text-white" />
          </button>
        </div>
      </div>

      {/* 工作区列表 */}
      <div className="max-h-[240px] overflow-y-auto">
        {mainWorkspaces.length === 0 ? (
          <div className="py-6 text-center text-sm text-text-tertiary">
            {searchQuery ? '未找到匹配的工作区' : '暂无工作区'}
          </div>
        ) : (
          <div className="py-1">
            {/* 主工作区标题 */}
            <div className="px-3 py-1.5 flex items-center gap-1">
              <span className="text-xs font-medium text-text-tertiary">主工作区</span>
              {isWorkspaceLocked && (
                <span className="flex items-center gap-0.5 text-amber-500 text-xs">
                  <Lock className="w-3 h-3" />
                  已锁定
                </span>
              )}
            </div>

            {/* 工作区项 */}
            {mainWorkspaces.map((workspace) => {
              const isCurrent = workspace.id === effectiveWorkspaceId
              const isContext = contextWorkspaceIds.includes(workspace.id)
              const isDisabled = isWorkspaceLocked && !isCurrent

              // 已关联的工作区显示
              if (isContext) {
                const contextWs = workspaces.find(w => w.id === workspace.id)
                if (!contextWs) return null
                return (
                  <button
                    key={workspace.id}
                    onClick={() => handleRemoveContextWorkspace(workspace.id)}
                    className={cn(
                      'w-full mx-1 px-3 py-2 rounded-lg text-left transition-colors',
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
              }

              return (
                <button
                  key={workspace.id}
                  onClick={() => handleWorkspaceClick(workspace.id)}
                  disabled={isDisabled}
                  className={cn(
                    'w-full mx-1 px-3 py-2 rounded-lg text-left transition-colors',
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

                  <div className="flex-1 min-w-0">
                    <div className={cn(
                      'text-sm truncate',
                      isCurrent ? 'text-primary font-medium' : 'text-text-primary'
                    )}>
                      {workspace.name}
                    </div>
                    <div className="text-xs text-text-tertiary truncate">
                      {workspace.path}
                    </div>
                  </div>

                  {/* 快速添加关联按钮 */}
                  {!isCurrent && !isDisabled && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleAddContextWorkspace(workspace.id)
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-background-hover transition-opacity"
                      title="添加到关联"
                    >
                      <Plus className="w-3 h-3 text-text-tertiary" />
                    </button>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 底部：关联管理入口 */}
      <div className="border-t border-border-subtle p-1">
        <button
          onClick={() => setShowContextModal(true)}
          className={cn(
            'w-full flex items-center gap-2 px-3 py-2 rounded-lg',
            'text-sm text-text-secondary hover:text-text-primary',
            'hover:bg-background-hover transition-colors'
          )}
        >
          <Link className="w-4 h-4" />
          <span>关联工作区管理</span>
          {contextWorkspaceIds.length > 0 && (
            <span className="ml-auto text-xs text-primary bg-primary/10 px-1.5 py-0.5 rounded">
              {contextWorkspaceIds.length}
            </span>
          )}
        </button>
      </div>

      {/* 新增工作区弹窗 */}
      {showCreateModal && (
        <CreateWorkspaceModal onClose={() => setShowCreateModal(false)} />
      )}

      {/* 关联工作区管理弹窗 */}
      {showContextModal && (
        <ContextWorkspaceModal
          sessionId={sessionId}
          workspaces={workspaces}
          effectiveWorkspaceId={effectiveWorkspaceId}
          contextWorkspaceIds={contextWorkspaceIds}
          isWorkspaceLocked={isWorkspaceLocked}
          onAdd={handleAddContextWorkspace}
          onRemove={handleRemoveContextWorkspace}
          onClose={() => setShowContextModal(false)}
        />
      )}
    </div>
  )
}

/**
 * 关联工作区管理弹窗
 */
interface ContextWorkspaceModalProps {
  sessionId: string
  workspaces: Array<{ id: string; name: string; path: string }>
  effectiveWorkspaceId: string | null
  contextWorkspaceIds: string[]
  isWorkspaceLocked: boolean
  onAdd: (workspaceId: string) => void
  onRemove: (workspaceId: string) => void
  onClose: () => void
}

function ContextWorkspaceModal({
  workspaces,
  effectiveWorkspaceId,
  contextWorkspaceIds,
  onAdd,
  onRemove,
  onClose
}: ContextWorkspaceModalProps) {
  // 点击外部关闭
  const modalRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [onClose])

  // 已关联的工作区
  const contextWorkspaces = workspaces.filter(w => contextWorkspaceIds.includes(w.id))

  // 可添加的工作区
  const availableWorkspaces = workspaces.filter(
    w => w.id !== effectiveWorkspaceId && !contextWorkspaceIds.includes(w.id)
  )

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div ref={modalRef} className="w-[400px] max-h-[480px] bg-background-elevated border border-border rounded-xl shadow-lg overflow-hidden">
        {/* 标题 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-base font-semibold text-text-primary">关联工作区管理</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-background-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容 */}
        <div className="p-4 overflow-y-auto max-h-[400px]">
          {/* 当前关联 */}
          {contextWorkspaces.length > 0 && (
            <div className="mb-4">
              <div className="text-xs font-medium text-text-tertiary mb-2">当前关联</div>
              <div className="space-y-1">
                {contextWorkspaces.map((workspace) => (
                  <div
                    key={workspace.id}
                    className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/20 rounded-lg"
                  >
                    <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />
                    <span className="flex-1 text-sm text-text-primary truncate">{workspace.name}</span>
                    <button
                      onClick={() => onRemove(workspace.id)}
                      className="px-2 py-0.5 text-xs border border-border rounded hover:bg-red-500/10 hover:border-red-500 hover:text-red-500 transition-colors"
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 可添加 */}
          <div>
            <div className="text-xs font-medium text-text-tertiary mb-2">可添加</div>
            {availableWorkspaces.length === 0 ? (
              <div className="py-4 text-center text-sm text-text-tertiary">
                暂无其他工作区可关联
              </div>
            ) : (
              <div className="space-y-1">
                {availableWorkspaces.map((workspace) => (
                  <div
                    key={workspace.id}
                    className="flex items-center gap-2 px-3 py-2 bg-background-surface border border-border-subtle rounded-lg"
                  >
                    <Plus className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
                    <span className="flex-1 text-sm text-text-secondary truncate">{workspace.name}</span>
                    <button
                      onClick={() => onAdd(workspace.id)}
                      className="px-2 py-0.5 text-xs border border-primary text-primary rounded hover:bg-primary/10 transition-colors"
                    >
                      添加
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
