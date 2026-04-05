/**
 * WorkspaceQuickSwitch - 顶部工作区快速切换组件
 *
 * 支持快速切换全局工作区（currentWorkspaceId）
 * 不影响会话的工作区绑定
 */

import { useState, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils/cn'
import { Check, Plus, Trash2, ChevronDown } from 'lucide-react'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { CreateWorkspaceModal } from './CreateWorkspaceModal'
import { createLogger } from '@/utils/logger'

const log = createLogger('WorkspaceQuickSwitch')

export function WorkspaceQuickSwitch() {
  const { t } = useTranslation('workspace')

  // Store 数据
  const workspacesRaw = useWorkspaceStore((state) => state.workspaces)
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId)
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace)
  const deleteWorkspace = useWorkspaceStore((state) => state.deleteWorkspace)
  const isLoading = useWorkspaceStore((state) => state.isLoading)

  // 按最近访问排序
  const sortedWorkspaces = useMemo(() =>
    [...workspacesRaw].sort((a, b) =>
      new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime()
    ), [workspacesRaw]
  )

  // 当前工作区
  const currentWorkspace = useMemo(() =>
    workspacesRaw.find(w => w.id === currentWorkspaceId),
    [workspacesRaw, currentWorkspaceId]
  )

  // 内部状态
  const [showDropdown, setShowDropdown] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // 点击外部关闭
  const dropdownRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false)
        setShowDeleteConfirm(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // 切换工作区
  const handleSwitchWorkspace = async (id: string) => {
    if (id === currentWorkspaceId || isLoading) return

    try {
      await switchWorkspace(id)
      setShowDropdown(false)
    } catch (error) {
      log.error('切换工作区失败', error instanceof Error ? error : new Error(String(error)))
    }
  }

  // 删除工作区
  const handleDeleteWorkspace = async (id: string) => {
    if (sortedWorkspaces.length <= 1) return

    setDeletingId(id)
    try {
      await deleteWorkspace(id)
      setShowDeleteConfirm(null)
      setShowDropdown(false)
    } catch (error) {
      log.error('删除工作区失败', error instanceof Error ? error : new Error(String(error)))
    } finally {
      setDeletingId(null)
    }
  }

  // 无工作区时不显示
  if (sortedWorkspaces.length === 0 || !currentWorkspace) {
    return null
  }

  return (
    <div ref={dropdownRef} className="relative flex items-center">
      {/* 触发按钮 */}
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className="flex items-center gap-1.5 h-7 px-2 rounded-md transition-colors hover:bg-background-hover"
        title={currentWorkspace.path}
        data-tauri-drag-region={false}
      >
        {/* 工作区名称 */}
        <span className="text-sm text-text-primary truncate max-w-[100px]">
          {currentWorkspace.name}
        </span>

        {/* 下拉箭头 */}
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 text-text-tertiary shrink-0 transition-transform',
            showDropdown && 'rotate-180'
          )}
        />
      </button>

      {/* 下拉菜单 */}
      {showDropdown && (
        <div
          className="absolute left-0 top-full mt-1 bg-background-elevated border border-border rounded-xl shadow-xl z-50 overflow-hidden min-w-[200px] max-w-[280px]"
          data-tauri-drag-region={false}
        >
          {/* 工作区列表 */}
          <div className="max-h-[240px] overflow-y-auto p-1">
            {sortedWorkspaces.map((workspace) => (
              <div
                key={workspace.id}
                className="group relative"
              >
                <button
                  onClick={() => handleSwitchWorkspace(workspace.id)}
                  disabled={isLoading || workspace.id === currentWorkspaceId}
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm transition-colors',
                    workspace.id === currentWorkspaceId
                      ? 'bg-primary/10 text-primary'
                      : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
                  )}
                >
                  {/* 当前标记 */}
                  <span
                    className={cn(
                      'w-1.5 h-1.5 rounded-full shrink-0 mt-0.5',
                      workspace.id === currentWorkspaceId ? 'bg-primary' : 'bg-text-tertiary'
                    )}
                  />

                  <div className="flex-1 min-w-0 text-left">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium truncate">{workspace.name}</span>
                      {workspace.id === currentWorkspaceId && (
                        <Check className="w-3.5 h-3.5 shrink-0" />
                      )}
                    </div>
                    <div className="text-xs truncate text-text-tertiary mt-0.5 leading-tight">
                      {workspace.path}
                    </div>
                  </div>
                </button>

                {/* 删除按钮（非当前工作区且超过1个工作区时显示） */}
                {workspace.id !== currentWorkspaceId && sortedWorkspaces.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setShowDeleteConfirm(workspace.id)
                    }}
                    disabled={deletingId === workspace.id}
                    className={cn(
                      'absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md transition-all',
                      'opacity-0 group-hover:opacity-100',
                      'text-text-tertiary hover:text-danger hover:bg-danger/10',
                      deletingId === workspace.id && 'opacity-50 cursor-not-allowed'
                    )}
                    title={t('selector.deleteWorkspace')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* 分隔线 */}
          <div className="border-t border-border-subtle" />

          {/* 新建按钮 */}
          <div className="p-1">
            <button
              onClick={() => {
                setShowDropdown(false)
                setShowCreateModal(true)
              }}
              className="w-full flex items-center gap-2 px-2 py-2 text-sm text-text-secondary hover:text-primary hover:bg-background-hover transition-colors rounded-lg"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('selector.createWorkspace')}</span>
            </button>
          </div>

          {/* 删除确认弹窗（内嵌） */}
          {showDeleteConfirm && (
            <div
              className="absolute inset-0 bg-background-elevated/95 backdrop-blur-sm flex items-center justify-center p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="bg-background-surface border border-border rounded-xl p-4 max-w-[220px]">
                <p className="text-sm text-text-primary mb-2">
                  {t('selector.confirmDelete', {
                    name: sortedWorkspaces.find(w => w.id === showDeleteConfirm)?.name
                  })}
                </p>
                <p className="text-xs text-text-tertiary mb-4">
                  {t('selector.deleteHint')}
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowDeleteConfirm(null)}
                    className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors"
                  >
                    {t('common:buttons.cancel')}
                  </button>
                  <button
                    onClick={() => handleDeleteWorkspace(showDeleteConfirm)}
                    disabled={deletingId === showDeleteConfirm}
                    className={cn(
                      'px-3 py-1.5 text-sm bg-danger text-white rounded-lg transition-colors',
                      'hover:bg-danger-hover',
                      deletingId === showDeleteConfirm && 'opacity-50 cursor-not-allowed'
                    )}
                  >
                    {deletingId === showDeleteConfirm ? '...' : t('common:buttons.delete')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 新建工作区弹窗 */}
      {showCreateModal && (
        <CreateWorkspaceModal onClose={() => setShowCreateModal(false)} />
      )}
    </div>
  )
}