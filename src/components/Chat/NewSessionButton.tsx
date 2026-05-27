import { memo, useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Plus, Folder, Check, Bot, Cpu } from 'lucide-react';
import { useViewStore, useWorkspaceStore, useConfigStore } from '@/stores';
import {
  useSessionMetadataList,
  useSessionManagerActions,
} from '@/stores/conversationStore/sessionStoreManager';
import type { EngineId } from '@/types';
import { getEngineFullName, normalizeEngineId } from '@/utils/engineDisplay';

/**
 * 新建会话按钮
 */
export const NewSessionButton = memo(function NewSessionButton() {
  const { t } = useTranslation('chat');
  const multiSessionMode = useViewStore(state => state.multiSessionMode);
  const multiSessionIds = useViewStore(state => state.multiSessionIds);
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
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // 最多 16 个会话（与 viewStore 上限一致）
  const canAdd = multiSessionIds.length < 16;

  const engineOptions = useMemo(() => [
    { id: 'claude-code' as EngineId, label: 'Claude', Icon: Bot },
    { id: 'codex' as EngineId, label: 'Codex', Icon: Cpu },
  ], []);

  useEffect(() => {
    if (!isOpen) {
      setSelectedEngineId(defaultEngineId);
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

  // 创建会话
  const handleCreateSession = useCallback((workspaceId?: string) => {
    const newSessionId = createSession({
      type: workspaceId ? 'project' : 'free',
      title: t('newSession.newChat', { number: allSessionMetadata.length + 1 }),
      workspaceId,
      workspaceLocked: Boolean(workspaceId),
      engineId: selectedEngineId,
    });
    // createSession 已自动处理 addToMultiView，此处无需手动调用
    switchSession(newSessionId);
    setIsOpen(false);
  }, [createSession, allSessionMetadata.length, selectedEngineId, switchSession, t]);

  // 非多会话模式或已达上限，不显示
  if (!multiSessionMode || !canAdd) {
    return null;
  }

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
          className={clsx(
            'absolute left-0 bottom-full mb-1 z-50',
            'min-w-[220px] max-h-[320px] overflow-y-auto py-1 rounded-lg shadow-lg',
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

          {/* 无工作区选项 */}
          <button
            onClick={() => handleCreateSession(undefined)}
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

          {/* 工作区列表 */}
          {sortedWorkspaces.map(workspace => (
            <button
              key={workspace.id}
              onClick={() => handleCreateSession(workspace.id)}
              className={clsx(
                'w-full flex items-center gap-2 px-3 py-1.5 text-sm',
                'text-text-secondary hover:text-text-primary hover:bg-background-hover',
                'transition-colors'
              )}
            >
              <Folder className="w-4 h-4 text-primary" />
              <span className="truncate">{workspace.name}</span>
              {workspace.id === currentWorkspaceId && (
                <Check className="w-3 h-3 text-primary ml-auto" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
