/**
 * 创建工作区弹窗组件
 */

import React, { useState } from 'react';
import { useWorkspaceStore } from '../../stores';
import { Button } from '../Common';

interface CreateWorkspaceModalProps {
  onClose: () => void;
}

export function CreateWorkspaceModal({ onClose }: CreateWorkspaceModalProps) {
  const { createWorkspace } = useWorkspaceStore();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [switchAfterCreate, setSwitchAfterCreate] = useState(true); // 默认切换到新工作区
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !path.trim()) {
      setError('请填写完整信息');
      return;
    }

    setIsLoading(true);
    setError('');
    
    try {
      await createWorkspace(name.trim(), path.trim(), switchAfterCreate);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : '创建工作区失败');
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
        title: '选择工作区文件夹',
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
      console.error('选择文件夹失败:', error);
      setError('选择文件夹失败，请手动输入路径');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-glow">
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          创建新工作区
        </h2>

        {error && (
          <div className="mb-4 p-3 bg-danger-faint text-danger rounded-lg text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              工作区名称
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如: 我的项目"
              className="w-full px-3 py-2 bg-background-surface border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary"
              autoFocus
              disabled={isLoading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              工作区路径
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="选择项目文件夹"
                className="flex-1 px-3 py-2 bg-background-surface border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary"
                disabled={isLoading}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={handleSelectFolder}
                disabled={isLoading}
              >
                浏览
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
              <div className="font-medium">切换到新工作区</div>
              <div className="text-xs text-text-tertiary mt-1">
                {switchAfterCreate
                  ? '创建后立即切换到新工作区'
                  : '创建后添加到关联工作区，不切换当前工作区'
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
              取消
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || !path.trim() || isLoading}
            >
              {isLoading ? '创建中...' : '创建'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}