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
import { Bot, Check, Zap, ChevronDown } from 'lucide-react'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useConfigStore } from '@/stores/configStore'
import { useModelProfileStore } from '@/stores/modelProfileStore'
import { useSessionManagerActions } from '@/stores/conversationStore/sessionStoreManager'
import { Button } from '@/components/Common'
import { CreateWorkspaceModal } from '@/components/Workspace/CreateWorkspaceModal'
import { WorkspaceSearchInput, useWorkspaceFilter } from '@/components/Workspace/WorkspaceSearchInput'
import { createLogger } from '@/utils/logger'
import type { EngineId } from '@/types'
import { getEngineFullName, normalizeEngineId } from '@/utils/engineDisplay'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'
import { SessionConfigSelector } from '@/components/Chat/session/SessionConfigSelector'
import type { SessionRuntimeConfig } from '@/types/sessionConfig'
import { useSessionConfig } from '@/stores/sessionConfigStore'
import {
  readNewSessionPrefs,
  persistNewSessionPrefs,
} from '@/services/newSessionPrefsService'
import { OFFICIAL_API_PROFILE } from '@/types/modelProfile'

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
  // 引擎/供应商模型区默认折叠为一行摘要（spec：plans/create-session-modal-slimdown-spec.md）
  const [providerExpanded, setProviderExpanded] = useState(false)
  const [engineId, setEngineId] = useState<EngineId>(defaultEngineId)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCreateWorkspaceModal, setShowCreateWorkspaceModal] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // 新建会话模型供应商/模型（面板态）：默认跟随全局（sessionConfig 镜像 + 全局激活 Profile）。
  // 打开时若 cap.kv 有该引擎的记忆则恢复（见下方 effect），保持「按引擎记忆」语义。
  const globalSessionConfig = useSessionConfig(s => s.config)
  const globalActiveProfileId = useConfigStore(s => s.config?.activeModelProfileId) ?? null
  const [providerConfig, setProviderConfig] = useState<SessionRuntimeConfig>(() => ({
    profileMode: globalSessionConfig.profileMode ?? 'profile',
    modelProfileId: globalSessionConfig.modelProfileId || globalActiveProfileId || '',
    model: globalSessionConfig.model,
  }))

  // 跨渲染共享最新面板态（供创建回调与 cap.kv 持久化使用）
  const providerModeRef = useRef(providerConfig.profileMode ?? 'profile')
  const modelProfileIdRef = useRef(providerConfig.modelProfileId ?? '')
  const modelRef = useRef(providerConfig.model ?? '')
  useEffect(() => {
    providerModeRef.current = providerConfig.profileMode ?? 'profile'
    modelProfileIdRef.current = providerConfig.modelProfileId ?? ''
    modelRef.current = providerConfig.model ?? ''
  }, [providerConfig])

  // 新建会话偏好记忆：cap.kv 按引擎分层（new-session-prefs:{engineId}）。
  // 打开时 / 引擎切换时恢复该引擎上次选择；创建时写回当前面板态。
  const rememberProvider = () => {
    void persistNewSessionPrefs(engineId, {
      providerMode: providerModeRef.current,
      modelProfileId: modelProfileIdRef.current,
      model: modelRef.current,
    })
  }

  // 已恢复过的引擎（防止引擎切换回来时反复覆盖面板当前选择）
  const restoredEngineRef = useRef<EngineId | null>(null)
  useEffect(() => {
    if (restoredEngineRef.current === engineId) return
    restoredEngineRef.current = engineId
    let cancelled = false
    void readNewSessionPrefs(engineId).then((prefs) => {
      if (cancelled || !prefs) return
      setProviderConfig({
        profileMode: prefs.providerMode,
        modelProfileId: prefs.modelProfileId,
        model: prefs.model,
      })
    })
    return () => { cancelled = true }
  }, [engineId])

  // 搜索过滤
  const showSearch = sortedWorkspaces.length > 3
  const filteredWorkspaces = useWorkspaceFilter(sortedWorkspaces, showSearch ? searchQuery : '')

  // 默认选中当前工作区（仅当尚未选择；严格区分 null=未选 与 ''=自由会话）
  useEffect(() => {
    if (currentWorkspaceId && primaryWorkspaceId === null) {
      setPrimaryWorkspaceId(currentWorkspaceId)
    }
  }, [currentWorkspaceId, primaryWorkspaceId])

  useEffect(() => {
    setEngineId(defaultEngineId)
  }, [defaultEngineId])

  // 模型 Profile 列表（折叠摘要行显示所选供应商名用）
  const profiles = useModelProfileStore(s => s.profiles)

  const engineMetadatas = useEngineMetadataStore(s => s.metadatas)
  const engineOptions = useMemo(() => {
    if (engineMetadatas.length > 0) {
      return engineMetadatas.map(meta => ({
        id: meta.id as EngineId,
        label: meta.name,
        Icon: Bot,
      }))
    }
    return [
      { id: 'claude-code' as EngineId, label: 'Claude', Icon: Bot },
      { id: 'simple-ai' as EngineId, label: 'Simple', Icon: Zap },
    ]
  }, [engineMetadatas])

  // 记住的引擎已不可用（被移除/插件卸载）时回退全局默认（与 NewSessionButton 同款护栏）
  useEffect(() => {
    if (!engineOptions.some(o => o.id === engineId)) {
      setEngineId(defaultEngineId)
    }
  }, [engineOptions, engineId, defaultEngineId])

  // 折叠摘要行文案：引擎名 · 供应商（官方/Profile 名）· 模型
  const engineLabel = engineOptions.find(o => o.id === engineId)?.label ?? engineId
  const providerSummary = (() => {
    const mode = providerConfig.profileMode ?? 'profile'
    if (mode === 'official') return '官方接口'
    const profile = profiles.find(p => p.id === providerConfig.modelProfileId)
    const pName = profile?.name ?? (providerConfig.modelProfileId ? '未知供应商' : '未选择供应商')
    return providerConfig.model ? `${pName} · ${providerConfig.model}` : pName
  })()

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

  // 创建会话
  const handleCreate = async () => {
    // 哨兵 '' 表示"自由会话"（不绑定工作区）
    const isFreeMode = primaryWorkspaceId === ''

    if (!isFreeMode && !primaryWorkspaceId) {
      setError(t('createSessionModal.selectPrimary'))
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      // 面板选择的供应商/模型 → 会话级覆盖（official 用哨兵强制官方，优先级高于全局默认 Profile）
      const official = providerModeRef.current === 'official'
      const providerOverride: {
        profileMode: 'official' | 'profile'
        modelProfileId?: string
        model?: string
      } = {
        profileMode: official ? 'official' : 'profile',
        ...(official
          ? { modelProfileId: OFFICIAL_API_PROFILE }
          : modelProfileIdRef.current
            ? { modelProfileId: modelProfileIdRef.current }
            : {}),
        ...(modelRef.current ? { model: modelRef.current } : {}),
      }
      rememberProvider()
      const sessionId = createSession(
        isFreeMode
          ? {
              type: 'free',
              workspaceId: undefined,
              contextWorkspaceIds: [],
              engineId,
              ...providerOverride,
            }
          : {
              type: 'project',
              workspaceId: primaryWorkspaceId,
              // 关联工作区已从本弹窗移除（spec：create-session-modal-slimdown-spec.md）：
              // 管理入口收敛在 QuickSwitch 面板/会话内，不在创建时设置
              contextWorkspaceIds: [],
              workspaceLocked: true, // 创建时锁定主工作区
              engineId,
              ...providerOverride,
            }
      )

      log.info('创建会话成功', { sessionId, primaryWorkspaceId, isFreeMode, engineId })
      onCreated?.(sessionId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('createSessionModal.createFailed'))
    } finally {
      setIsLoading(false)
    }
  }

  // 按钮状态：自由会话（哨兵 ''）或已选主工作区都允许创建
  const canCreate = primaryWorkspaceId !== null && !isLoading

  // 使用 Portal 渲染到 body
  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-modal"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        ref={modalRef}
        data-modal="create-session"
        className="bg-background-elevated rounded-xl p-4 sm:p-6 w-full max-w-md max-h-[85vh] flex flex-col border border-border shadow-glow"
      >
        {/* 标题 */}
        <h2 className="shrink-0 text-lg font-semibold text-text-primary mb-4">
          {t('createSessionModal.title')}
        </h2>

        {/* 滚动内容区：矮窗口防裁切（标题/底部按钮常驻，中间内容滚动）
            —— 根因与布局取舍见 plans/create-session-modal-slimdown-spec.md */}
        <div className="min-h-0 overflow-y-auto">
          {/* 错误提示 */}
          {error && (
            <div className="mb-4 p-3 bg-danger-faint text-danger rounded-lg text-sm">
              {error}
            </div>
          )}

          {/* 主工作区选择区（无工作区时降级为引导） */}
          {sortedWorkspaces.length === 0 ? (
            <div className="py-4 text-center space-y-3">
              <p className="text-text-secondary">{t('createSessionModal.noWorkspace')}</p>
              {/* 自由会话：即使无工作区也可创建 */}
              <button
                type="button"
                onClick={() => setPrimaryWorkspaceId('')}
                className={cn(
                  'w-full max-w-xs mx-auto flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors',
                  primaryWorkspaceId === ''
                    ? 'bg-primary/10 text-primary border-primary/30'
                    : 'text-text-secondary border-border-subtle hover:text-text-primary hover:bg-background-hover'
                )}
              >
                <Bot className="w-4 h-4" />
                自由会话（不绑定工作区）
              </button>
              <div className="text-xs text-text-tertiary">或先创建专属工作区</div>
              <Button variant="primary" onClick={() => setShowCreateWorkspaceModal(true)}>
                {t('createSessionModal.createWorkspaceFirst')}
              </Button>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-2">
                {t('createSessionModal.primaryWorkspaceLabel')} *
              </label>
              {/* 自由会话选项 */}
              <button
                type="button"
                onClick={() => setPrimaryWorkspaceId('')}
                className={cn(
                  'w-full text-left px-3 py-2 text-sm rounded-lg border mb-2 transition-colors',
                  primaryWorkspaceId === ''
                    ? 'bg-primary/10 text-primary border-primary/30'
                    : 'text-text-secondary border-border-subtle hover:text-text-primary hover:bg-background-hover'
                )}
              >
                <div className="flex items-center gap-2">
                  {primaryWorkspaceId === '' && <Check className="w-4 h-4 shrink-0" />}
                  <Bot className="w-4 h-4 shrink-0 text-text-muted" />
                  <span>自由会话（不绑定工作区）</span>
                </div>
                <div className={cn(
                  'text-xs truncate mt-0.5',
                  primaryWorkspaceId === '' ? 'text-primary/70' : 'text-text-tertiary'
                )}>
                  AI 不注入任何工作区上下文
                </div>
              </button>
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
          )}

          {/* 引擎 + 模型供应商/模型：默认折叠为一行摘要（cap.kv 记忆通常已对，点开才改）。
              置于主工作区之后：SessionConfigSelector 下拉向上弹（bottom-full），
              靠底展开才有足够头部空间，避免被本滚动容器裁切。 */}
          <div className="mt-4 pt-3 border-t border-border-subtle">
            <button
              type="button"
              onClick={() => setProviderExpanded(v => !v)}
              aria-expanded={providerExpanded}
              title="点击展开修改引擎 / 供应商 / 模型"
              className="w-full flex items-center gap-2 px-1 py-1.5 text-xs rounded transition-colors hover:bg-background-hover"
            >
              <Bot className="w-3.5 h-3.5 shrink-0 text-text-muted" />
              <span className="font-medium text-text-secondary shrink-0">{engineLabel}</span>
              <span className="truncate text-text-tertiary">{providerSummary}</span>
              <ChevronDown className={cn(
                'w-3.5 h-3.5 ml-auto shrink-0 text-text-muted transition-transform',
                providerExpanded && 'rotate-180'
              )} />
            </button>
            {providerExpanded && (
              <div className="mt-2 space-y-3">
                {/* AI 引擎选择 */}
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

                {/* 模型供应商 + 模型（按当前待选引擎过滤 Profile；面板内选择，不写回当前会话） */}
                <SessionConfigSelector
                  config={providerConfig}
                  onChange={setProviderConfig}
                  visibleTypes={['profile', 'model']}
                  variant="panel"
                  engineOverride={engineId}
                  writeThroughToSession={false}
                />
              </div>
            )}
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="shrink-0 flex justify-end gap-2 pt-4 mt-4 border-t border-border-subtle">
          <Button variant="ghost" onClick={onClose} disabled={isLoading}>
            {t('common:buttons.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={!canCreate || (sortedWorkspaces.length === 0 && primaryWorkspaceId !== '')}
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
