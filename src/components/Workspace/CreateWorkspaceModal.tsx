/**
 * 创建工作区弹窗组件
 */

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useWorkspaceStore } from '../../stores';
import { Button } from '../Common';
import { createLogger } from '../../utils/logger';

const log = createLogger('CreateWorkspaceModal');

interface CreateWorkspaceModalProps {
  onClose: () => void;
}

export function CreateWorkspaceModal({ onClose }: CreateWorkspaceModalProps) {
  const { t } = useTranslation('workspace');
  const { createWorkspace } = useWorkspaceStore();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [switchAfterCreate, setSwitchAfterCreate] = useState(true); // 默认切换到新工作区
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // 点击外部关闭
  const modalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // 检查点击是否在 modal 内容区域内
      if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
        // 阻止事件继续传播，避免触发父组件（如 WorkspaceDropdown）的点击外部处理
        event.stopPropagation();
        onClose();
      }
    };
    // 使用 capture 阶段，确保在父组件的处理之前执行
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
    };
  }, [onClose]);

  // ESC 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !path.trim()) {
      setError(t('createModal.fillRequired'));
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      await createWorkspace(name.trim(), path.trim(), switchAfterCreate);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : t('createModal.createFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectFolder = async () => {
    try {
      // 使用正确的 Tauri 2.0 dialog 插件 API
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('createModal.selectFolderTitle'),
      });

      if (selected && !Array.isArray(selected)) {
        setPath(selected);
        // 如果名称为空，使用文件夹名称作为默认名称
        if (!name.trim()) {
          const folderName = selected.split(/[/\\]/).pop() || '';
          setName(folderName);
        }
      }
    } catch (error) {
      log.error('选择文件夹失败', error instanceof Error ? error : new Error(String(error)));
      setError(t('createModal.selectFolderFailed'));
    }
  };

  // 使用 Portal 渲染到 body，确保居中定位正确
  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div ref={modalRef} data-modal="create-workspace" className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-glow">
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          {t('createModal.title')}
        </h2>

        {error && (
          <div className="mb-4 p-3 bg-danger-faint text-danger rounded-lg text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              {t('createModal.nameLabel')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('createModal.namePlaceholder')}
              className="w-full px-3 py-2 bg-background-surface border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary"
              autoFocus
              disabled={isLoading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              {t('createModal.pathLabel')}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={t('createModal.pathPlaceholder')}
                className="flex-1 px-3 py-2 bg-background-surface border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary"
                disabled={isLoading}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={handleSelectFolder}
                disabled={isLoading}
              >
                {t('createModal.browse')}
              </Button>
            </div>
          </div>

          {/* 选择是否切换到新工作区 */}
          <div className="flex items-start gap-2 pt-2 border-t border-border-subtle pt-4">
            <input
              type="checkbox"
              id="switchAfterCreate"
              checked={switchAfterCreate}
              onChange={(e) => setSwitchAfterCreate(e.target.checked)}
              className="mt-1 w-4 h-4 rounded border-border text-primary focus:ring-primary"
              disabled={isLoading}
            />
            <label htmlFor="switchAfterCreate" className="flex-1 text-sm text-text-secondary">
              <div className="font-medium">{t('createModal.switchToNew')}</div>
              <div className="text-xs text-text-tertiary mt-1">
                {switchAfterCreate
                  ? t('createModal.switchHint')
                  : t('createModal.noSwitchHint')
                }
              </div>
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={isLoading}
            >
              {t('common:buttons.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || !path.trim() || isLoading}
            >
              {isLoading ? t('createModal.creating') : t('createModal.create')}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}