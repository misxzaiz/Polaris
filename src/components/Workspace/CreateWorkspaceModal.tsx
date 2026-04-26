/**
 * 创建工作区弹窗组件
 */

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useWorkspaceStore } from '../../stores';
import { Button } from '../Common';
import { createLogger } from '../../utils/logger';
import { invoke } from '@/services/transport';

const log = createLogger('CreateWorkspaceModal');

interface DirectoryInfo {
  name: string;
  path: string;
  isDir: boolean;
}

interface CreateWorkspaceModalProps {
  onClose: () => void;
}

/**
 * 服务端目录浏览器 — Web 模式下替代浏览器原生文件选择器。
 * 通过 read_directory / get_home_dir 命令浏览服务端文件系统，
 * 确保拿到的是完整绝对路径。
 */
function ServerDirectoryPicker({
  onSelect,
  onCancel,
}: {
  onSelect: (path: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('workspace');
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<DirectoryInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pathHistory, setPathHistory] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  // 初始化：获取 home 目录
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const home = await invoke<string>('get_home_dir');
        setCurrentPath(home);
        setPathHistory([home]);
        await loadDirectory(home);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function loadDirectory(dirPath: string) {
    setLoading(true);
    setError('');
    try {
      const items = await invoke<DirectoryInfo[]>('read_directory', { path: dirPath });
      // 只显示目录，按名称排序
      const dirs = items
        .filter((item) => item.isDir)
        .sort((a, b) => a.name.localeCompare(b.name));
      setEntries(dirs);
    } catch (e) {
      setError(String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  function navigateTo(dirPath: string) {
    setCurrentPath(dirPath);
    setPathHistory((prev) => [...prev, dirPath]);
    loadDirectory(dirPath);
  }

  function goBack() {
    if (pathHistory.length <= 1) return;
    const newHistory = pathHistory.slice(0, -1);
    const parentPath = newHistory[newHistory.length - 1];
    setPathHistory(newHistory);
    setCurrentPath(parentPath);
    loadDirectory(parentPath);
  }

  function goToParent() {
    const sep = currentPath.includes('\\') ? '\\' : '/';
    const parts = currentPath.split(sep).filter(Boolean);
    if (parts.length <= 1) return;
    // 保留根路径的分隔符
    const isWindowsRoot = /^[A-Za-z]:$/.test(parts[0]);
    const parentParts = parts.slice(0, -1);
    const parentPath = isWindowsRoot && parentParts.length === 1
      ? parentParts[0] + sep
      : parentParts.join(sep);
    navigateTo(parentPath);
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[110]">
      <div className="bg-background-elevated rounded-xl w-full max-w-lg border border-border shadow-glow mx-4">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium text-text-primary">
            {t('createModal.selectFolderTitle')}
          </h3>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={goBack}
              disabled={pathHistory.length <= 1}
              className="p-1.5 text-text-secondary hover:text-text-primary disabled:opacity-30"
              title="Back"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              type="button"
              onClick={goToParent}
              disabled={loading}
              className="p-1.5 text-text-secondary hover:text-text-primary disabled:opacity-30"
              title="Parent directory"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="p-1.5 text-text-secondary hover:text-text-primary"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* 当前路径 */}
        <div className="px-4 py-2 border-b border-border-subtle">
          <code className="text-xs text-text-tertiary break-all">{currentPath}</code>
        </div>

        {/* 目录列表 */}
        <div ref={listRef} className="h-72 overflow-y-auto px-2 py-1">
          {loading && (
            <div className="flex items-center justify-center h-full text-text-tertiary text-sm">
              ...
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-full text-red-400 text-xs">
              {error}
            </div>
          )}
          {!loading && !error && entries.length === 0 && (
            <div className="flex items-center justify-center h-full text-text-tertiary text-xs">
              {t('createModal.noSubdirectories')}
            </div>
          )}
          {!loading && entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm text-text-primary hover:bg-surface group"
              onClick={() => navigateTo(entry.path)}
              onDoubleClick={() => onSelect(entry.path)}
            >
              <svg className="w-4 h-4 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <span className="truncate">{entry.name}</span>
            </button>
          ))}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <span className="text-xs text-text-tertiary truncate max-w-[200px]">
            {currentPath}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onCancel}>
              {t('common:buttons.cancel')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => onSelect(currentPath)}
              disabled={loading || !currentPath}
            >
              {t('createModal.selectCurrent')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CreateWorkspaceModal({ onClose }: CreateWorkspaceModalProps) {
  const { t } = useTranslation('workspace');
  const { createWorkspace } = useWorkspaceStore();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [switchAfterCreate, setSwitchAfterCreate] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);

  // 点击外部关闭
  const modalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
        event.stopPropagation();
        onClose();
      }
    };
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
      // Web 模式：使用服务端目录浏览器，获取完整绝对路径
      if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
        setShowDirectoryPicker(true);
        return;
      }

      // Tauri 桌面端：使用 dialog 插件
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('createModal.selectFolderTitle'),
      });

      if (selected && !Array.isArray(selected)) {
        setPath(selected);
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

  const handleDirectorySelect = (selectedPath: string) => {
    setShowDirectoryPicker(false);
    setPath(selectedPath);
    if (!name.trim()) {
      const folderName = selectedPath.split(/[/\\]/).pop() || '';
      setName(folderName);
    }
  };

  return (
    <>
      {/* 服务端目录浏览器（Web 模式） */}
      {showDirectoryPicker && (
        <ServerDirectoryPicker
          onSelect={handleDirectorySelect}
          onCancel={() => setShowDirectoryPicker(false)}
        />
      )}

      {createPortal(
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
      )}
    </>
  );
}
