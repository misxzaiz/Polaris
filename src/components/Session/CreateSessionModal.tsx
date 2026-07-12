/**
 * CreateSessionModal - 新建会话弹窗组件
 *
 * 用户必须选择主工作区，可选选择关联工作区
 * 创建后主工作区锁定，不可修改
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils/cn'
import { Bot, Check, Cpu, Sparkles, Zap } from 'lucide-react'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useConfigStore } from '@/stores/configStore'
import { useSessionManagerActions } from '@/stores/conversationStore/sessionStoreManager'
import { Button } from '@/components/Common'
import { CreateWorkspaceModal } from '@/components/Workspace/CreateWorkspaceModal'
import { WorkspaceSearchInput, useWorkspaceFilter } from '@/components/Workspace/WorkspaceSearchInput'
import { createLogger } from '@/utils/logger'
import type { EngineId } from '@/types'
import { getEngineFullName, normalizeEngineId } from '@/utils/engineDisplay'

const log = createLogger('CreateSessionModal')

interface CreateSessionModalProps {
  /** 关闭弹窗回调 */
  onClose: () => void
  /** 创建成功后的回调（可选） */
  onCreated?: (sessionId: string) => void
}

export function CreateSessionModal({ onClose, onCreated }: CreateSessionModalProps) {
  const { t } = useTranslation('workspace')

  // Store 数据
  const workspacesRaw = useWorkspaceStore((state) => state.workspaces)
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId)
  const { createSession } = useSessionManagerActions()
  const { config } = useConfigStore()
  const defaultEngineId = normalizeEngineId(config?.defaultEngine)

  // 按最近访问排序的工作区列表
  const sortedWorkspaces = useMemo(() =>
    [...workspacesRaw].sort((a, b) =>
      new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime()
    ), [workspacesRaw]
  )

  // 内部状态
  const [primaryWorkspaceId, setPrimaryWorkspaceId] = useState<string | null>(null)
  const [contextWorkspaceIds, setContextWorkspaceIds] = useState<string[]>([])
  const [engineId, setEngineId] = useState<EngineId>(defaultEngineId)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCreateWorkspaceModal, setShowCreateWorkspaceModal] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // 搜索过滤
  const showSearch = sortedWorkspaces.length > 3
  const filteredWorkspaces = useWorkspaceFilter(sortedWorkspaces, showSearch ? searchQuery : '')

  // 默认选中当前工作区
  useEffect(() => {
    if (currentWorkspaceId && !primaryWorkspaceId) {
      setPrimaryWorkspaceId(currentWorkspaceId)
    }
  }, [currentWorkspaceId, primaryWorkspaceId])

  useEffect(() => {
    setEngineId(defaultEngineId)
  }, [defaultEngineId])

  const engineOptions = useMemo(() => [
    { id: 'claude-code' as EngineId, label: 'Claude', Icon: Bot },
    { id: 'codex' as EngineId, label: 'Codex', Icon: Cpu },
    { id: 'simple-ai' as EngineId, label: 'Simple', Icon: Zap },
    { id: 'mimo' as EngineId, label: 'Mimo', Icon: Sparkles },
  ], [])

  // 点击外部关闭
  const modalRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // 如果点击的是另一个弹窗（如 CreateWorkspaceModal），不关闭当前弹窗
      const target = event.target as HTMLElement
      if (target.closest('[data-modal]')) {
        return
      }
      if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside, true)
    return () => document.removeEventListener('mousedown', handleClickOutside, true)
  }, [onClose])

  // ESC 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // 切换关联工作区
  const handleToggleContextWorkspace = (workspaceId: string) => {
    if (contextWorkspaceIds.includes(workspaceId)) {
      setContextWorkspaceIds(prev => prev.filter(id => id !== workspaceId))
    } else {
      setContextWorkspaceIds(prev => [...prev, workspaceId])
    }
  }

  // 创建会话
  const handleCreate = async () => {
    if (!primaryWorkspaceId) {
      setError(t('createSessionModal.selectPrimary'))
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const sessionId = createSession({
        type: 'project',
        workspaceId: primaryWorkspaceId,
        contextWorkspaceIds,
        workspaceLocked: true, // 创建时锁定主工作区
        engineId,
      })

      log.info('创建会话成功', { sessionId, primaryWorkspaceId, contextWorkspaceIds, engineId })
      onCreated?.(sessionId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('createSessionModal.createFailed'))
    } finally {
      setIsLoading(false)
    }
  }

  // 按钮状态
  const canCreate = primaryWorkspaceId !== null && !isLoading

  // 使用 Portal 渲染到 body
  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        ref={modalRef}
        data-modal="create-session"
        className="bg-background-elevated rounded-xl p-4 sm:p-6 w-full max-w-lg border border-border shadow-glow"
      >
        {/* 标题 */}
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          {t('createSessionModal.title')}
        </h2>

        {/* 错误提示 */}
        {error && (
          <div className="mb-4 p-3 bg-danger-faint text-danger rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* 无工作区时的提示 */}
        {sortedWorkspaces.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-text-secondary mb-4">{t('createSessionModal.noWorkspace')}</p>
            <Button variant="primary" onClick={() => setShowCreateWorkspaceModal(true)}>
              {t('createSessionModal.createWorkspaceFirst')}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* AI 引擎选择区 */}
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-2">
                AI 引擎
              </label>
              <div className="grid grid-cols-2 gap-2">
                {engineOptions.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setEngineId(id)}
                    disabled={isLoading}
                    title={getEngineFullName(id)}
                    className={cn(
                      'flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors',
                      engineId === id
                        ? 'bg-primary/10 text-primary border-primary/30'
                        : 'text-text-secondary border-border-subtle hover:text-text-primary hover:bg-background-hover'
                    )}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 主工作区选择区 */}
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-2">
                {t('createSessionModal.primaryWorkspaceLabel')} *
              </label>
              {showSearch && (
                <WorkspaceSearchInput
                  value={searchQuery}
                  onChange={setSearchQuery}
                  className="mb-2"
                  autoFocus
                />
              )}
              <div className="max-h-48 overflow-y-auto border border-border rounded-lg">
                {filteredWorkspaces.map((workspace, index) => (
                  <button
                    key={workspace.id}
                    onClick={() => setPrimaryWorkspaceId(workspace.id)}
                    disabled={isLoading}
                    className={cn(
                      'w-full text-left px-3 py-2.5 text-sm transition-colors',
                      index !== filteredWorkspaces.length - 1 && 'border-b border-border-subtle',
                      workspace.id === primaryWorkspaceId
                        ? 'bg-primary/10 text-primary'
                        : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {workspace.id === primaryWorkspaceId && (
                        <Check className="w-4 h-4 shrink-0" />
                      )}
                      <span className="font-medium truncate">{workspace.name}</span>
                    </div>
                    <div className={cn(
                      'text-xs truncate mt-0.5',
                      workspace.id === primaryWorkspaceId ? 'text-primary/70' : 'text-text-tertiary'
                    )}>
                      {workspace.path}
                    </div>
                  </button>
                ))}
              </div>
              {/* 快捷新增按钮 */}
              <button
                onClick={() => setShowCreateWorkspaceModal(true)}
                className="mt-2 text-sm text-primary hover:text-primary-hover transition-colors"
              >
                + {t('createSessionModal.addWorkspace')}
              </button>
            </div>

            {/* 关联工作区选择区（可选，有多个工作区时显示） */}
            {sortedWorkspaces.length > 1 && (
              <div className="pt-4 border-t border-border-subtle">
                <label className="block text-sm font-medium text-text-secondary mb-2">
                  {t('createSessionModal.contextWorkspaceLabel')}
                  <span className="text-xs text-text-tertiary ml-1">
                    ({t('createSessionModal.optional')})
                  </span>
                </label>
                <div className="max-h-32 overflow-y-auto border border-border rounded-lg">
                  {filteredWorkspaces
                    .filter(w => w.id !== primaryWorkspaceId)
                    .map((workspace, index, arr) => {
                      const isContext = contextWorkspaceIds.includes(workspace.id)
                      return (
                        <label
                          key={workspace.id}
                          className={cn(
                            'flex items-start px-3 py-2 text-sm cursor-pointer',
                            'hover:bg-background-hover transition-colors',
                            index !== arr.length - 1 && 'border-b border-border-subtle',
                            isContext && 'bg-primary/5'
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={isContext}
                            onChange={() => handleToggleContextWorkspace(workspace.id)}
                            className="w-4 h-4 mt-0.5 rounded border-border text-primary focus:ring-primary shrink-0"
                          />
                          <div className="ml-2 min-w-0 flex-1">
                            <div className={cn('truncate', isContext ? 'text-primary' : 'text-text-secondary')}>
                              {workspace.name}
                            </div>
                            <div className="text-xs truncate text-text-tertiary mt-0.5">
                              {workspace.path}
                            </div>
                          </div>
                        </label>
                      )
                    })}
                </div>
                {contextWorkspaceIds.length > 0 && (
                  <p className="mt-2 text-xs text-text-tertiary">
                    {t('createSessionModal.contextHint')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* 底部按钮 */}
        <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-border-subtle">
          <Button variant="ghost" onClick={onClose} disabled={isLoading}>
            {t('common:buttons.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={!canCreate || sortedWorkspaces.length === 0}
          >
            {isLoading ? t('createSessionModal.creating') : t('createSessionModal.create')}
          </Button>
        </div>
      </div>

      {/* 新建工作区弹窗 */}
      {showCreateWorkspaceModal && (
        <CreateWorkspaceModal onClose={() => setShowCreateWorkspaceModal(false)} />
      )}
    </div>,
    document.body
  )
}
