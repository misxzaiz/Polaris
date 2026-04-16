/**
 * 工作区选择器组件
 */

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkspaceStore } from '../../stores';
import { Button } from '../Common';
import { CreateWorkspaceModal } from './CreateWorkspaceModal';
import { WorkspaceSearchInput, useWorkspaceFilter } from './WorkspaceSearchInput';
import { createLogger } from '../../utils/logger';

const log = createLogger('WorkspaceSelector');

export function WorkspaceSelector() {
  const { t } = useTranslation('workspace');
  const {
    workspaces: workspacesRaw,
    currentWorkspaceId,
    switchWorkspace,
    deleteWorkspace,
    error,
    clearError,
  } = useWorkspaceStore();

  const workspaces = useMemo(() =>
    workspacesRaw.slice().sort((a, b) =>
      new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime()
    ), [workspacesRaw]
  );

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // 搜索过滤
  const filteredWorkspaces = useWorkspaceFilter(workspaces, searchQuery);

  const handleSwitchWorkspace = async (id: string) => {
    if (id === currentWorkspaceId) return;
    
    try {
      await switchWorkspace(id);
    } catch (error) {
      log.error('切换工作区失败', error instanceof Error ? error : new Error(String(error)));
    }
  };

  const handleDeleteWorkspace = async (id: string) => {
    try {
      await deleteWorkspace(id);
      setShowDeleteConfirm(null);
    } catch (error) {
      log.error('删除工作区失败', error instanceof Error ? error : new Error(String(error)));
    }
  };

  // 如果没有工作区，显示创建提示
  if (workspaces.length === 0) {
    return (
      <>
        <div className="p-3 border-b border-border">
          <div className="text-center py-4">
            <div className="w-12 h-12 rounded-lg bg-background-surface border border-border flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              </svg>
            </div>
            <p className="text-sm text-text-secondary mb-3">
              {t('selector.noWorkspace')}
            </p>
            <Button
              onClick={() => setShowCreateModal(true)}
              className="w-full"
            >
              {t('selector.createWorkspace')}
            </Button>
          </div>
        </div>

        {showCreateModal && (
          <CreateWorkspaceModal
            onClose={() => setShowCreateModal(false)}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="p-3 border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-text-tertiary">{t('selector.workspace')}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCreateModal(true)}
            className="p-1 h-6"
            title={t('selector.createWorkspaceTitle')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </Button>
        </div>

        {error && (
          <div className="mb-2 p-2 bg-danger-faint text-danger rounded text-xs">
            {error}
            <button
              onClick={clearError}
              className="ml-1 text-danger hover:text-danger-hover"
            >
              ×
            </button>
          </div>
        )}

        {/* 搜索框 - 工作区超过3个时显示 */}
        {workspaces.length > 3 && (
          <div className="mb-2">
            <WorkspaceSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
            />
          </div>
        )}

        {/* 工作区列表 */}
        <div className="space-y-1">
          {filteredWorkspaces.length === 0 ? (
            <div className="py-3 text-center text-sm text-text-tertiary">
              {t('search.noResults')}
            </div>
          ) : (
            filteredWorkspaces.map((workspace) => (
              <div
                key={workspace.id}
                className={`group relative rounded-lg transition-colors ${
                  workspace.id === currentWorkspaceId
                    ? 'bg-primary text-white'
                    : 'hover:bg-background-hover'
                }`}
              >
                <button
                  onClick={() => handleSwitchWorkspace(workspace.id)}
                  className={`w-full text-left px-2 py-2 rounded-lg text-sm transition-colors ${
                    workspace.id === currentWorkspaceId
                      ? 'text-white'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  <div className="font-medium truncate">{workspace.name}</div>
                  <div className={`text-xs truncate ${
                    workspace.id === currentWorkspaceId
                      ? 'text-white/70'
                      : 'text-text-tertiary'
                  }`}>
                    {workspace.path}
                  </div>
                  {workspace.id === currentWorkspaceId && (
                    <div className="mt-1 space-y-1">
                      <div className="flex items-center gap-1">
                        <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                        <span className="text-xs">{t('selector.currentWorkspaceLabel')}</span>
                      </div>
                      <div className="text-xs text-white/80 bg-white/10 rounded px-1.5 py-0.5">
                        {workspace.path}
                      </div>
                    </div>
                  )}
                </button>

                {/* 删除按钮（仅在非当前工作区显示） */}
                {workspace.id !== currentWorkspaceId && filteredWorkspaces.length > 1 && (
                  <button
                    onClick={() => setShowDeleteConfirm(workspace.id)}
                    className={`absolute right-1 top-1 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity ${
                      workspace.id === currentWorkspaceId
                        ? 'hover:bg-white/20 text-white'
                        : 'hover:bg-background-surface text-text-tertiary hover:text-danger'
                    }`}
                    title={t('selector.deleteWorkspace')}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* 创建工作区弹窗 */}
      {showCreateModal && (
        <CreateWorkspaceModal
          onClose={() => setShowCreateModal(false)}
        />
      )}

      {/* 删除确认弹窗 */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-elevated rounded-xl p-6 w-full max-w-sm border border-border">
            <h3 className="text-lg font-semibold text-text-primary mb-2">
              {t('selector.deleteWorkspaceTitle')}
            </h3>
            <p className="text-sm text-text-secondary mb-4">
              {t('selector.confirmDelete', { name: workspaces.find(w => w.id === showDeleteConfirm)?.name })}
              <br />
              {t('selector.deleteHint')}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setShowDeleteConfirm(null)}
              >
                {t('common:buttons.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => handleDeleteWorkspace(showDeleteConfirm)}
              >
                {t('common:buttons.delete')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}