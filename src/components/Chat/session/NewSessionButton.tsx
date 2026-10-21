import { memo, useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Plus, Folder, Check, Bot, Search, Zap, Link } from 'lucide-react';
import { useWorkspaceStore, useConfigStore } from '@/stores';
import {
  useSessionMetadataList,
  useSessionManagerActions,
} from '@/stores/conversationStore/sessionStoreManager';
import { useWorkspaceFilter } from '@/components/Workspace/WorkspaceSearchInput';
import type { EngineId } from '@/types';
import { getEngineFullName, normalizeEngineId } from '@/utils/engineDisplay';
import { useEngineMetadataStore } from '@/stores/engineMetadataStore';
import { SessionConfigSelector } from './SessionConfigSelector';
import type { SessionRuntimeConfig } from '@/types/sessionConfig';
import { useSessionConfig } from '@/stores/sessionConfigStore';
import {
  readNewSessionPrefs,
  persistNewSessionPrefs,
} from '@/services/newSessionPrefsService';
import { OFFICIAL_API_PROFILE } from '@/types/modelProfile';

/**
 * 新建会话按钮
 *
 * 工作区选择交互（参照 WorkspaceMenu 范式）：
 * - 列表项双行显示 name + path
 * - 点工作区本体 = 选定主工作区（高亮，可改，不立即创建）
 * - 行尾 + / ✓ = 增删关联工作区
 * - 底部「创建」按钮提交（回车也可）
 *
 * 引擎 + 模型供应商/模型记忆：cap.kv 按引擎分层（new-session-prefs:{engineId}），
 * 每次打开面板恢复该引擎上次选择；创建时写回；不再使用 localStorage。
 */
export const NewSessionButton = memo(function NewSessionButton() {
  const { t } = useTranslation('chat');
  const { createSession, switchSession } = useSessionManagerActions();
  const { config } = useConfigStore();
  const defaultEngineId = normalizeEngineId(config?.defaultEngine);

  // 工作区列表 - 直接订阅原始数据，避免函数调用导致无限循环
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const currentWorkspaceId = useWorkspaceStore(state => state.currentWorkspaceId);

  // 在组件内排序，使用 useMemo 保持引用稳定
  const sortedWorkspaces = useMemo(() => {
    return [...workspaces].sort((a, b) =>
      new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime()
    );
  }, [workspaces]);

  // 会话列表（用于生成标题）
  const allSessionMetadata = useSessionMetadataList();

  // 下拉菜单状态
  const [isOpen, setIsOpen] = useState(false);
  // 新建会话引擎：跟随全局默认引擎（面板内可切换；cap.kv 记忆在打开时恢复，见下方 effect）。
  const [selectedEngineId, setSelectedEngineId] = useState<EngineId>(defaultEngineId);

  // 新建会话模型供应商/模型（面板态）：默认跟随全局（sessionConfig 镜像 + 全局激活 Profile）。
  // providerMode = 二态（官方/Profile），与 SessionMetadata.profileMode 语义一致。
  const globalSessionConfig = useSessionConfig(s => s.config);
  const globalActiveProfileId = useConfigStore(s => s.config?.activeModelProfileId) ?? null;
  const [providerConfig, setProviderConfig] = useState<SessionRuntimeConfig>(() => ({
    profileMode: globalSessionConfig.profileMode ?? 'profile',
    modelProfileId: globalSessionConfig.modelProfileId || globalActiveProfileId || '',
    model: globalSessionConfig.model,
  }));

  // 跨渲染共享最新面板态（供 cap.kv 持久化与创建回调使用，避免闭包过期）
  const providerModeRef = useRef(providerConfig.profileMode ?? 'profile');
  const modelProfileIdRef = useRef(providerConfig.modelProfileId ?? '');
  const modelRef = useRef(providerConfig.model ?? '');
  useEffect(() => {
    providerModeRef.current = providerConfig.profileMode ?? 'profile';
    modelProfileIdRef.current = providerConfig.modelProfileId ?? '';
    modelRef.current = providerConfig.model ?? '';
  }, [providerConfig]);

  // 新建会话偏好记忆：cap.kv 按引擎分层（new-session-prefs:{engineId}），
  // 面板内存态 = 浏览态事实源，cap.kv 只做持久化（创建时写回，下次打开恢复）。
  const rememberEngine = (engineId: EngineId) => {
    void persistNewSessionPrefs(engineId, {
      providerMode: providerModeRef.current,
      modelProfileId: modelProfileIdRef.current,
      model: modelRef.current,
    });
  };
  const [searchQuery, setSearchQuery] = useState('');
  // 主工作区 + 关联工作区待定状态（两步式选择）
  const [pendingPrimaryId, setPendingPrimaryId] = useState<string | null>(null);
  const [pendingContextIds, setPendingContextIds] = useState<string[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // fixed 定位坐标：按钮位于状态栏中段，absolute 左对齐时 w-72 面板在窄屏/
  // 窄聊天面板下会超出视口右缘，被 App 根容器 overflow-hidden 裁剪（视觉上偏右）。
  // 参照 DispatchCenter 范式：按钮 rect + 视口钳制的 fixed 定位
  const [panelPos, setPanelPos] = useState<{ left: number; bottom: number } | null>(null);

  const PANEL_WIDTH = 288; // 对应 w-72
  const PANEL_MARGIN = 8;

  const updatePanelPos = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const maxLeft = window.innerWidth - PANEL_WIDTH - PANEL_MARGIN;
    const left = Math.max(PANEL_MARGIN, Math.min(rect.left, maxLeft));
    // 面板底边贴按钮上方 4px（原 bottom-full mb-1 的间距）
    const bottom = Math.max(PANEL_MARGIN, window.innerHeight - rect.top + 4);
    setPanelPos({ left, bottom });
  }, []);

  useEffect(() => {
    if (isOpen) updatePanelPos();
  }, [isOpen, updatePanelPos]);

  // 窗口尺寸变化时重算面板位置
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener('resize', updatePanelPos);
    return () => window.removeEventListener('resize', updatePanelPos);
  }, [isOpen, updatePanelPos]);

  // 搜索过滤
  const showSearch = sortedWorkspaces.length > 3;
  const filteredWorkspaces = useWorkspaceFilter(sortedWorkspaces, showSearch ? searchQuery : '');

  // 是否支持关联工作区（多于 1 个工作区且已选主工作区时）
  const canPickContext = sortedWorkspaces.length > 1 && pendingPrimaryId !== null;

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
  }, [engineMetadatas]);

  // 记住的引擎已不可用（被移除/插件卸载）时回退全局默认。
  useEffect(() => {
    if (!engineOptions.some(o => o.id === selectedEngineId)) {
      setSelectedEngineId(defaultEngineId);
    }
  }, [engineOptions, selectedEngineId, defaultEngineId]);

  // 面板打开 / 引擎切换：从 cap.kv 恢复「上次新建会话选择」的供应商与模型。
  // 恢复失败（无记录/解析失败）→ 保留当前面板态（打开时 = 全局默认），静默降级。
  const restoredEngineRef = useRef<EngineId | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    if (restoredEngineRef.current === selectedEngineId) return; // 已恢复过该引擎
    restoredEngineRef.current = selectedEngineId;
    let cancelled = false;
    void readNewSessionPrefs(selectedEngineId).then((prefs) => {
      if (cancelled) return;
      if (prefs) {
        setProviderConfig({
          profileMode: prefs.providerMode,
          modelProfileId: prefs.modelProfileId,
          model: prefs.model,
        });
      }
    });
    return () => { cancelled = true; };
  }, [isOpen, selectedEngineId]);

  useEffect(() => {
    if (!isOpen) {
      // 不重置 selectedEngineId：保留上次选择（会话引擎记忆）。
      setSearchQuery('');
      setPendingPrimaryId(null);
      setPendingContextIds([]);
    }
  }, [isOpen]);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // 切换关联工作区
  const handleToggleContext = useCallback((workspaceId: string) => {
    setPendingContextIds(prev =>
      prev.includes(workspaceId)
        ? prev.filter(id => id !== workspaceId)
        : [...prev, workspaceId]
    );
  }, []);

  // 面板当前选择的供应商/模型 → createSession 会话级覆盖参数
  // - official → 写 OFFICIAL_API_PROFILE 哨兵（发送链路解析为 undefined=强制官方，
  //   优先级高于全局默认 Profile；若留空则会被全局默认 Profile 覆盖，语义不一致）
  // - profile → 写实际 Profile id；模型仅在已选时透传
  const providerSelection = useCallback((): {
    profileMode: 'official' | 'profile'
    modelProfileId?: string
    model?: string
  } => {
    const official = providerModeRef.current === 'official'
    return {
      profileMode: official ? 'official' : 'profile',
      ...(official
        ? { modelProfileId: OFFICIAL_API_PROFILE }
        : modelProfileIdRef.current
          ? { modelProfileId: modelProfileIdRef.current }
          : {}),
      ...(modelRef.current ? { model: modelRef.current } : {}),
    }
  }, [])

  // 创建会话（带主+关联工作区）
  const handleCreateWithWorkspace = useCallback(() => {
    if (!pendingPrimaryId) return;
    rememberEngine(selectedEngineId);
    const newSessionId = createSession({
      type: 'project',
      title: t('newSession.newChat', { number: allSessionMetadata.length + 1 }),
      workspaceId: pendingPrimaryId,
      contextWorkspaceIds: pendingContextIds,
      workspaceLocked: true,
      engineId: selectedEngineId,
      // 面板选择的供应商/模型透传为会话级覆盖（发送链路已消费 modelProfileId/model/profileMode）
      ...providerSelection(),
    });
    switchSession(newSessionId);
    setIsOpen(false);
  }, [createSession, allSessionMetadata.length, pendingPrimaryId, pendingContextIds, selectedEngineId, switchSession, t, providerSelection]);

  // 无工作区快路径（free 会话，点选即建）
  const handleCreateNoWorkspace = useCallback(() => {
    rememberEngine(selectedEngineId);
    const newSessionId = createSession({
      type: 'free',
      title: t('newSession.newChat', { number: allSessionMetadata.length + 1 }),
      engineId: selectedEngineId,
      // 面板选择的供应商/模型透传为会话级覆盖
      ...providerSelection(),
    });
    switchSession(newSessionId);
    setIsOpen(false);
  }, [createSession, allSessionMetadata.length, selectedEngineId, switchSession, t, providerSelection]);

  // 回车提交
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && pendingPrimaryId) {
      e.preventDefault();
      handleCreateWithWorkspace();
    }
  }, [pendingPrimaryId, handleCreateWithWorkspace]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          'p-1.5 rounded transition-colors',
          isOpen
            ? 'bg-primary/10 text-primary'
            : 'text-text-muted hover:text-text-primary hover:bg-background-hover'
        )}
        title={t('newSession.title')}
      >
        <Plus className="w-4 h-4" />
      </button>

      {/* 下拉菜单 - 向上展开（fixed + 视口钳制，防窄屏下越出右缘被裁剪） */}
      {isOpen && panelPos && (
        <div
          ref={dropdownRef}
          onKeyDown={handleKeyDown}
          className={clsx(
            'fixed z-dropdown',
            'w-72 max-w-[calc(100vw-16px)] flex flex-col rounded-lg shadow-lg',
            'bg-background-elevated border border-border'
          )}
          style={{ left: panelPos.left, bottom: panelPos.bottom }}
        >
          <div className="px-2 pb-2 border-b border-border-subtle">
            <div className="px-1 py-1 text-[11px] font-medium text-text-tertiary">{t('newSession.aiEngine')}</div>
            <div className="grid grid-cols-2 gap-1">
              {engineOptions.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  onClick={() => {
                    setSelectedEngineId(id);
                    // 不在此持久化：切换只是读取目标引擎的记忆（见恢复 effect），写回发生在创建时
                  }}
                  className={clsx(
                    'flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-colors',
                    selectedEngineId === id
                      ? 'bg-primary/10 text-primary border border-primary/30'
                      : 'text-text-secondary hover:text-text-primary hover:bg-background-hover border border-border-subtle'
                  )}
                  title={getEngineFullName(id)}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            {/* 模型供应商 + 模型（按当前待选引擎过滤 Profile；面板内选择，不写回当前会话） */}
            <div className="px-1 pt-2 mt-2 border-t border-border-subtle">
              <SessionConfigSelector
                config={providerConfig}
                onChange={setProviderConfig}
                visibleTypes={['profile', 'model']}
                variant="panel"
                engineOverride={selectedEngineId}
                writeThroughToSession={false}
              />
            </div>
          </div>

          {/* 无工作区选项（快路径：点选即建 free 会话） */}
          <button
            onClick={handleCreateNoWorkspace}
            className={clsx(
              'w-full flex items-center gap-2 px-3 py-1.5 text-sm',
              'text-text-secondary hover:text-text-primary hover:bg-background-hover',
              'transition-colors'
            )}
          >
            <Folder className="w-4 h-4 text-text-muted" />
            <span>{t('newSession.noWorkspace')}</span>
          </button>

          {/* 分隔线 */}
          {sortedWorkspaces.length > 0 && (
            <div className="my-1 border-t border-border-subtle" />
          )}

          {/* 搜索框 */}
          {showSearch && (
            <div className="px-2 py-1">
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none">
                  <Search className="w-3 h-3 text-text-tertiary" />
                </div>
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('newSession.searchWorkspace', '搜索工作区...')}
                  className="w-full pl-7 pr-2 py-1 text-xs bg-background-surface border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  autoFocus
                />
              </div>
            </div>
          )}

          {/* 工作区列表（双行 name + path，行尾 +/✓ 切关联） */}
          <div className="max-h-[260px] overflow-y-auto">
            {filteredWorkspaces.length === 0 && sortedWorkspaces.length > 0 && (
              <div className="py-4 text-center text-xs text-text-tertiary">
                {t('newSession.noResults', '无匹配工作区')}
              </div>
            )}
            {filteredWorkspaces.map(workspace => {
              const isPrimary = workspace.id === pendingPrimaryId;
              const isContext = pendingContextIds.includes(workspace.id);
              const showContextBtn = canPickContext && workspace.id !== pendingPrimaryId;

              return (
                <div
                  key={workspace.id}
                  className={clsx(
                    'group relative flex items-center',
                    isPrimary && 'bg-primary/10',
                    workspace.id === currentWorkspaceId && !isPrimary && 'bg-background-hover/50'
                  )}
                >
                  {/* 当前全局工作区左侧指示条 */}
                  {workspace.id === currentWorkspaceId && (
                    <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary/40" />
                  )}

                  <button
                    onClick={() => setPendingPrimaryId(workspace.id)}
                    className={clsx(
                      'flex-1 text-left px-3 py-1.5 text-sm transition-colors',
                      isPrimary
                        ? 'text-primary'
                        : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
                    )}
                  >
                    <div className="flex items-center gap-1.5 pr-8">
                      {isPrimary && <Check className="w-3.5 h-3.5 shrink-0" />}
                      <Folder className={clsx('w-3.5 h-3.5 shrink-0', isPrimary ? 'text-primary' : 'text-text-muted')} />
                      <span className="font-medium truncate">{workspace.name}</span>
                    </div>
                    <div className={clsx(
                      'text-xs truncate mt-0.5 pl-5',
                      isPrimary ? 'text-primary/70' : 'text-text-tertiary'
                    )}>
                      {workspace.path}
                    </div>
                  </button>

                  {/* 关联工作区切换按钮 */}
                  {showContextBtn && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleContext(workspace.id);
                      }}
                      className={clsx(
                        'absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-colors',
                        isContext
                          ? 'text-primary bg-primary/10'
                          : 'text-text-tertiary hover:text-primary hover:bg-background-hover opacity-0 group-hover:opacity-100'
                      )}
                      title={isContext ? t('newSession.removeContext') : t('newSession.addContext')}
                    >
                      {isContext ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <Plus className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* 底部操作条 */}
          <div className="border-t border-border-subtle px-2 py-1.5">
            {pendingPrimaryId ? (
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1 text-[11px] text-text-tertiary truncate">
                  <Link className="w-3 h-3 shrink-0" />
                  {t('newSession.contextCount', { count: pendingContextIds.length })}
                </span>
                <button
                  onClick={handleCreateWithWorkspace}
                  className={clsx(
                    'px-3 py-1 rounded-md text-xs font-medium transition-colors',
                    'bg-primary text-primary-foreground hover:bg-primary-hover'
                  )}
                >
                  {t('newSession.create')}
                </button>
              </div>
            ) : (
              <div className="text-[11px] text-text-tertiary text-center py-0.5">
                {t('newSession.selectPrimaryHint')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
