/**
 * TopMenuBar Component
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Minus, Square, X, Clock, Download, PanelRight, Pin } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore, useViewStore, useEventChatStore } from '../../stores';
import * as tauri from '../../services/tauri';
import { exportToMarkdown, generateFileName } from '../../services/chatExport';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createLogger } from '../../utils/logger';

const log = createLogger('TopMenuBar');

// 检测是否在 Tauri 环境中运行
const isTauriEnv = typeof window !== 'undefined' && '__TAURI__' in window;

interface TopMenuBarProps {
  onNewConversation: () => void;
  onCreateWorkspace: () => void;
  onToggleRightPanel?: () => void;
  rightPanelCollapsed?: boolean;
  isCompactMode?: boolean;
}

export function TopMenuBar({ onNewConversation, onCreateWorkspace, onToggleRightPanel, rightPanelCollapsed, isCompactMode }: TopMenuBarProps) {
  const { t } = useTranslation('common');
  const { getCurrentWorkspace } = useWorkspaceStore();
  const { toggleSessionHistory } = useViewStore();
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false);
  const [showNewChatConfirm, setShowNewChatConfirm] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const { clearMessages, messages } = useEventChatStore();

  const currentWorkspace = getCurrentWorkspace();

  const contextCount = useWorkspaceStore(state => state.contextWorkspaceIds.length);

  useEffect(() => {
    if (!isTauriEnv) return;

    const checkMaximized = async () => {
      try {
        const window = getCurrentWindow();
        const maximized = await window.isMaximized();
        setIsMaximized(maximized);
      } catch (error) {
        log.warn('Failed to check maximized state:', { error: String(error) });
      }
    };

    checkMaximized();

    const window = getCurrentWindow();
    const unlisten = window.onResized(() => {
      checkMaximized();
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, []);

  // 同步置顶状态
  useEffect(() => {
    if (!isTauriEnv) return;

    const syncOnTopState = async () => {
      try {
        const onTop = await invoke<boolean>('is_always_on_top');
        setIsAlwaysOnTop(onTop);
      } catch (error) {
        log.warn('Failed to get always on top state:', { error: String(error) });
      }
    };
    syncOnTopState();
  }, []);

  const handleExportChat = async () => {
    if (messages.length === 0) {
      return;
    }

    setIsExporting(true);
    try {
      const content = exportToMarkdown(messages, currentWorkspace?.name);
      const fileName = generateFileName('md');
      const filePath = await tauri.saveChatToFile(content, fileName);

      if (filePath) {
        log.info('导出聊天成功', { path: filePath });
      }
    } catch (error) {
      log.error('导出聊天失败', error instanceof Error ? error : new Error(String(error)));
    } finally {
      setIsExporting(false);
    }
  };

  const handleNewConversation = () => {
    if (messages.length > 0) {
      setShowNewChatConfirm(true);
    } else {
      clearMessages();
      onNewConversation();
    }
  };

  const confirmNewChat = () => {
    clearMessages();
    onNewConversation();
    setShowNewChatConfirm(false);
  };

  // 切换窗口置顶状态
  const handleToggleAlwaysOnTop = async () => {
    try {
      const newOnTop = !isAlwaysOnTop;
      await invoke('set_always_on_top', { alwaysOnTop: newOnTop });
      setIsAlwaysOnTop(newOnTop);
      log.info(`窗口置顶: ${newOnTop}`);
    } catch (error) {
      log.error('切换置顶失败', error instanceof Error ? error : new Error(String(error)));
    }
  };

  return (
    <div className="flex items-center h-10 bg-background-elevated border-b border-border shrink-0">
      {/* 左侧:Logo/应用名称 - 小屏模式下更紧凑 */}
      <div data-tauri-drag-region className={`flex items-center gap-2 ${isCompactMode ? 'px-2' : 'px-4'}`}>
        <div className="w-6 h-6 rounded bg-gradient-to-br from-primary to-primary-600 flex items-center justify-center shadow-glow" data-tauri-drag-region={false}>
          <span className="text-xs font-bold text-white">P</span>
        </div>
        {!isCompactMode && <span className="text-sm font-medium text-text-primary">Polaris</span>}
      </div>

      {/* 中间:可拖拽区域 (自动填充剩余空间) */}
      <div data-tauri-drag-region className="flex-1 h-full cursor-move" />

      {/* 右侧:菜单 + 窗口控制 - 小屏模式下简化 */}
      <div className="flex items-center">
        {/* 小屏模式：显示置顶按钮和窗口控制按钮 */}
        {isCompactMode ? (
          <>
            {/* 窗口置顶按钮 */}
            <button
              onClick={handleToggleAlwaysOnTop}
              className={`p-1.5 rounded-md transition-colors ${
                isAlwaysOnTop
                  ? 'text-primary bg-primary/10 hover:bg-primary/20'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
              }`}
              title={isAlwaysOnTop ? t('window.alwaysOnTop') : t('window.alwaysOnTopHint')}
              data-tauri-drag-region={false}
            >
              <Pin className="w-4 h-4" />
            </button>

            {/* 分隔线 */}
            <div data-tauri-drag-region className="w-px h-4 bg-border-subtle mx-1" />

            {/* 窗口控制 */}
            <div className="flex items-center">
              <button
                onClick={() => tauri.minimizeWindow()}
                className="px-2 py-2 hover:bg-background-hover transition-colors text-text-secondary hover:text-text-primary"
                title={t('window.minimize')}
                data-tauri-drag-region={false}
              >
                <Minus className="w-4 h-4" />
              </button>
              <button
                onClick={() => tauri.toggleMaximizeWindow()}
                className="px-2 py-2 hover:bg-background-hover transition-colors text-text-secondary hover:text-text-primary"
                title={isMaximized ? t('window.restore') : t('window.maximize')}
                data-tauri-drag-region={false}
              >
                <Square className="w-4 h-4" />
              </button>
              <button
                onClick={() => tauri.closeWindow()}
                className="px-2 py-2 hover:bg-red-500 hover:text-white transition-colors text-text-secondary"
                title={t('window.close')}
                data-tauri-drag-region={false}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </>
        ) : (
          <>
            {/* 正常模式：完整菜单 */}
            {/* 工作区选择器 */}
            <div className="relative">
              <button
                onClick={() => setShowWorkspaceMenu(!showWorkspaceMenu)}
                className="min-w-0 max-w-[200px] flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-text-secondary
                         hover:text-text-primary hover:bg-background-hover transition-colors"
                title={t('labels.workspace')}
                data-tauri-drag-region={false}
              >
                <span className="flex-1 truncate">
                  {currentWorkspace?.name || t('labels.noWorkspaceSelected')}
                </span>
                {contextCount > 0 && (
                  <span className="flex items-center justify-center w-4 h-4 text-xs bg-primary/20 text-primary rounded-full">
                    {contextCount}
                  </span>
                )}
                <svg className="shrink-0 w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* 工作区下拉菜单 */}
              {showWorkspaceMenu && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowWorkspaceMenu(false)}
                  />
                  <div className="absolute right-0 top-full mt-1 w-56 bg-background-surface border border-border rounded-lg shadow-xl z-20 overflow-hidden">
                    <WorkspaceMenuContent
                      onClose={() => setShowWorkspaceMenu(false)}
                      onCreateWorkspace={onCreateWorkspace}
                    />
                  </div>
                </>
              )}
            </div>

            {/* 分隔线 */}
            <div data-tauri-drag-region className="w-px h-4 bg-border-subtle mx-1" />

            {/* 右侧 AI 面板切换按钮 */}
            <button
              onClick={onToggleRightPanel}
              className={`p-1.5 rounded-md transition-colors ${
                rightPanelCollapsed
                  ? 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
                  : 'text-primary bg-primary/10 hover:bg-primary/20'
              }`}
              title={rightPanelCollapsed ? t('labels.showAIPanel') : t('labels.hideAIPanel')}
              data-tauri-drag-region={false}
            >
              <PanelRight className="w-4 h-4" />
            </button>

            <button
              onClick={handleExportChat}
              disabled={messages.length === 0 || isExporting}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={t('menu.exportChat')}
              data-tauri-drag-region={false}
            >
              {isExporting ? (
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 2l4 4-4 4" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 6h-4" />
                </svg>
              ) : (
                <Download className="w-4 h-4" />
              )}
            </button>

            <button
              onClick={toggleSessionHistory}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
              title={t('menu.sessionHistory')}
              data-tauri-drag-region={false}
            >
              <Clock className="w-4 h-4" />
            </button>

            <button
              onClick={handleNewConversation}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
              title={t('menu.newChat')}
              data-tauri-drag-region={false}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>

            {/* 窗口置顶按钮 */}
            <button
              onClick={handleToggleAlwaysOnTop}
              className={`p-1.5 rounded-md transition-colors ${
                isAlwaysOnTop
                  ? 'text-primary bg-primary/10 hover:bg-primary/20'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
              }`}
              title={isAlwaysOnTop ? t('window.alwaysOnTop') : t('window.alwaysOnTopHint')}
              data-tauri-drag-region={false}
            >
              <Pin className="w-4 h-4" />
            </button>

            {/* 分隔线 */}
            <div data-tauri-drag-region className="w-px h-4 bg-border-subtle mx-1" />

            <div className="flex items-center">
              <button
                onClick={() => tauri.minimizeWindow()}
                className="px-3 py-2 hover:bg-background-hover transition-colors text-text-secondary hover:text-text-primary"
                title={t('window.minimize')}
                data-tauri-drag-region={false}
              >
                <Minus className="w-4 h-4" />
              </button>
              <button
                onClick={() => tauri.toggleMaximizeWindow()}
                className="px-3 py-2 hover:bg-background-hover transition-colors text-text-secondary hover:text-text-primary"
                title={isMaximized ? t('window.restore') : t('window.maximize')}
                data-tauri-drag-region={false}
              >
                <Square className="w-4 h-4" />
              </button>
              <button
                onClick={() => tauri.closeWindow()}
                className="px-3 py-2 hover:bg-red-500 hover:text-white transition-colors text-text-secondary"
                title={t('window.close')}
                data-tauri-drag-region={false}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </>
        )}
      </div>

      {/* 新对话确认对话框 */}
      {showNewChatConfirm && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-50"
            onClick={() => setShowNewChatConfirm(false)}
          />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-80 bg-background-elevated rounded-xl border border-border shadow-xl p-5">
            <h3 className="text-base font-semibold text-text-primary mb-2">
              {t('messages.confirmNewChat')}
            </h3>
            <p className="text-sm text-text-secondary mb-5">
              {t('messages.confirmNewChatMessage', { count: messages.length })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowNewChatConfirm(false)}
                className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors"
              >
                {t('buttons.cancel')}
              </button>
              <button
                onClick={confirmNewChat}
                className="px-3 py-1.5 text-sm bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
              >
                {t('buttons.confirm')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 工作区菜单内容
 */
function WorkspaceMenuContent({ onCreateWorkspace }: {
  onClose?: () => void;
  onCreateWorkspace: () => void;
}) {
  const { t } = useTranslation('common');
  const {
    workspaces,
    currentWorkspaceId,
    contextWorkspaceIds,
    switchWorkspace,
    deleteWorkspace,
    toggleContextWorkspace,
    getCurrentWorkspace,
  } = useWorkspaceStore();

  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  const handleSwitchWorkspace = async (id: string) => {
    if (id !== currentWorkspaceId) {
      await switchWorkspace(id);
    }
  };

  const handleCreateWorkspace = () => {
    onCreateWorkspace();
  };

  const handleDeleteWorkspace = async (id: string) => {
    try {
      await deleteWorkspace(id);
      setShowDeleteConfirm(null);
    } catch (error) {
      console.error(t('workspace.deleteFailed'), error);
    }
  };

  const handleToggleContext = (id: string) => {
    toggleContextWorkspace(id);
  };

  const workspaceToDelete = workspaces.find(w => w.id === showDeleteConfirm);
  const currentWorkspace = getCurrentWorkspace();
  const contextWorkspaces = workspaces.filter(w => contextWorkspaceIds.includes(w.id));

  return (
    <div className="py-1 max-h-[60vh] overflow-y-auto">
      <div className="px-3 py-2 text-xs font-medium text-text-tertiary border-b border-border-subtle flex items-center justify-between">
        <span>{t('labels.currentWorkspace')}</span>
        <button
          onClick={handleCreateWorkspace}
          className="text-primary hover:text-primary-hover transition-colors"
        >
          + {t('buttons.create')}
        </button>
      </div>

      <div className="max-h-48 overflow-y-auto">
        {workspaces.map((workspace) => {
          const isCurrent = workspace.id === currentWorkspaceId;
          const isContext = contextWorkspaceIds.includes(workspace.id);

          return (
            <div
              key={workspace.id}
              className={`group relative flex items-center ${
                isCurrent ? 'bg-primary/10' : ''
              }`}
            >
              {/* 活动工作区指示 */}
              {isCurrent && (
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary" />
              )}

              <button
                onClick={() => handleSwitchWorkspace(workspace.id)}
                className={`flex-1 text-left px-3 py-2 text-sm transition-colors ${
                  isCurrent
                    ? 'text-primary'
                    : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
                }`}
              >
                <div className="pr-12 font-medium truncate flex items-center gap-2">
                  {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
                  {workspace.name}
                </div>
                <div className="text-xs truncate text-text-tertiary">
                  {workspace.path}
                </div>
              </button>

              {/* 上下文复选框（所有工作区都显示） */}
              {workspaces.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleContext(workspace.id);
                  }}
                  className={`absolute right-8 top-1/2 -translate-y-1/2 p-1 rounded transition-colors ${
                    isContext
                      ? 'text-primary bg-primary/10'
                      : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
                  }`}
                  title={isContext ? t('workspace.removeFromContext') : t('workspace.addToContext')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    {isContext ? (
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 4.784M14.12 14.12a3 3 0 100-4.243m4.242 4.242L9.878 9.878" />
                    )}
                  </svg>
                </button>
              )}

              {/* 删除按钮（非当前工作区） */}
              {!isCurrent && workspaces.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowDeleteConfirm(workspace.id);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-text-tertiary hover:text-danger hover:bg-background-surface opacity-0 group-hover:opacity-100 transition-opacity"
                title={t('buttons.delete')}
              >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-border-subtle mt-1 pt-1">
        <div className="px-3 py-2 text-xs text-text-tertiary flex items-center justify-between">
          <span className="flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {t('labels.contextWorkspaces')} ({contextWorkspaces.length + 1})
          </span>
        </div>

        {contextWorkspaces.length > 0 ? (
          <div className="max-h-32 overflow-y-auto">
            {currentWorkspace && (
              <div className="group flex items-center px-3 py-1.5 text-sm text-text-secondary bg-primary/5">
                <span className="w-2 h-2 rounded-full bg-primary mr-2" />
                <span className="flex-1 truncate">{currentWorkspace.name}</span>
                <span className="text-xs text-text-tertiary mr-2">{t('labels.currentWorkspace')}</span>
              </div>
            )}
            {contextWorkspaces.map((workspace) => (
              <div
                key={workspace.id}
                className="group flex items-center px-3 py-1.5 text-sm text-text-secondary hover:bg-background-hover"
              >
                <span className="w-2 h-2 rounded-full bg-primary/50 mr-2" />
                <span className="flex-1 truncate">{workspace.name}</span>
                <button
                  onClick={() => handleToggleContext(workspace.id)}
                  className="p-1 rounded text-text-tertiary hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity"
                  title={t('workspace.removeFromContext')}
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-3 py-3 text-xs text-text-tertiary text-center">
            {t('workspace.noContextWorkspaces')}
          </div>
        )}
      </div>

      {contextWorkspaces.length > 0 && (
        <div className="mx-2 my-2 p-2 bg-primary/5 border border-primary/20 rounded text-xs text-text-secondary">
          {t('workspace.aiCanAccess')}
        </div>
      )}

      {showDeleteConfirm && workspaceToDelete && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-50"
            onClick={() => setShowDeleteConfirm(null)}
          />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-80 bg-background-elevated rounded-xl border border-border shadow-xl p-5">
            <h3 className="text-base font-semibold text-text-primary mb-2">
              {t('messages.confirmDelete')}
            </h3>
            <p className="text-sm text-text-secondary mb-4">
              {t('messages.confirmDeleteWorkspace', { name: workspaceToDelete.name })}
            </p>
            <p className="text-xs text-text-tertiary mb-5">
              {t('messages.deleteWorkspaceHint')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowDeleteConfirm(null)}
                className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors"
              >
                {t('buttons.cancel')}
              </button>
              <button
                onClick={() => handleDeleteWorkspace(showDeleteConfirm)}
                className="px-3 py-1.5 text-sm bg-danger text-white rounded-lg hover:bg-danger-hover transition-colors"
              >
                {t('buttons.delete')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
