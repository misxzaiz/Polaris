import { memo, useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Plus, Folder, Check, Bot, Cpu, Search, Zap, Sparkles, Link } from 'lucide-react';
import { useWorkspaceStore, useConfigStore } from '@/stores';
import {
  useSessionMetadataList,
  useSessionManagerActions,
} from '@/stores/conversationStore/sessionStoreManager';
import { useWorkspaceFilter } from '@/components/Workspace/WorkspaceSearchInput';
import type { EngineId } from '@/types';
import { getEngineFullName, normalizeEngineId } from '@/utils/engineDisplay';

/**
 * 新建会话按钮
 *
 * 工作区选择交互（参照 WorkspaceMenu 范式）：
 * - 列表项双行显示 name + path
 * - 点工作区本体 = 选定主工作区（高亮，可改，不立即创建）
 * - 行尾 + / ✓ = 增删关联工作区
 * - 底部「创建」按钮提交（回车也可）
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
  const [selectedEngineId, setSelectedEngineId] = useState<EngineId>(defaultEngineId);
  const [searchQuery, setSearchQuery] = useState('');
  // 主工作区 + 关联工作区待定状态（两步式选择）
  const [pendingPrimaryId, setPendingPrimaryId] = useState<string | null>(null);
  const [pendingContextIds, setPendingContextIds] = useState<string[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 搜索过滤
  const showSearch = sortedWorkspaces.length > 3;
  const filteredWorkspaces = useWorkspaceFilter(sortedWorkspaces, showSearch ? searchQuery : '');

  // 是否支持关联工作区（多于 1 个工作区且已选主工作区时）
  const canPickContext = sortedWorkspaces.length > 1 && pendingPrimaryId !== null;

  const engineOptions = useMemo(() => [
    { id: 'claude-code' as EngineId, label: 'Claude', Icon: Bot },
    { id: 'codex' as EngineId, label: 'Codex', Icon: Cpu },
    { id: 'simple-ai' as EngineId, label: 'Simple', Icon: Zap },
    { id: 'mimo' as EngineId, label: 'Mimo', Icon: Sparkles },
  ], []);

  useEffect(() => {
    if (!isOpen) {
      setSelectedEngineId(defaultEngineId);
      setSearchQuery('');
      setPendingPrimaryId(null);
      setPendingContextIds([]);
    }
  }, [defaultEngineId, isOpen]);

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

  // 创建会话（带主+关联工作区）
  const handleCreateWithWorkspace = useCallback(() => {
    if (!pendingPrimaryId) return;
    const newSessionId = createSession({
      type: 'project',
      title: t('newSession.newChat', { number: allSessionMetadata.length + 1 }),
      workspaceId: pendingPrimaryId,
      contextWorkspaceIds: pendingContextIds,
      workspaceLocked: true,
      engineId: selectedEngineId,
    });
    switchSession(newSessionId);
    setIsOpen(false);
  }, [createSession, allSessionMetadata.length, pendingPrimaryId, pendingContextIds, selectedEngineId, switchSession, t]);

  // 无工作区快路径（free 会话，点选即建）
  const handleCreateNoWorkspace = useCallback(() => {
    const newSessionId = createSession({
      type: 'free',
      title: t('newSession.newChat', { number: allSessionMetadata.length + 1 }),
      engineId: selectedEngineId,
    });
    switchSession(newSessionId);
    setIsOpen(false);
  }, [createSession, allSessionMetadata.length, selectedEngineId, switchSession, t]);

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

      {/* 下拉菜单 - 向上展开 */}
      {isOpen && (
        <div
          ref={dropdownRef}
          onKeyDown={handleKeyDown}
          className={clsx(
            'absolute left-0 bottom-full mb-1 z-50',
            'w-72 flex flex-col rounded-lg shadow-lg',
            'bg-background-elevated border border-border'
          )}
        >
          <div className="px-2 pb-2 border-b border-border-subtle">
            <div className="px-1 py-1 text-[11px] font-medium text-text-tertiary">{t('newSession.aiEngine')}</div>
            <div className="grid grid-cols-2 gap-1">
              {engineOptions.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  onClick={() => setSelectedEngineId(id)}
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
