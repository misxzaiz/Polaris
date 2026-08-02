/**
 * 编辑器顶部栏组件
 *
 * 仅在需要时渲染（文件已修改 → 显示保存按钮；文件被外部修改 → 显示冲突提示）。
 * 关闭文件由顶部 TabBar 的关闭按钮负责，此处不再重复，避免额外占用垂直空间。
 *
 * 全局快捷键：Ctrl/Cmd+R 强制从磁盘重读当前文件（即使 header 不可见也生效）。
 */

import { useEffect } from 'react';
import { useFileEditorStore } from '@/stores';
import { createLogger } from '@/utils/logger';
import { modKey } from '@/utils/path';

const log = createLogger('EditorHeader');

interface EditorHeaderProps {
  className?: string;
}

export function EditorHeader({ className = '' }: EditorHeaderProps) {
  const { currentFile, saveFile, status, isConflicted, reloadFromDisk, setConflicted, refreshCurrentFile } = useFileEditorStore();

  // Ctrl/Cmd+R: 强制从磁盘重读当前文件（无未保存改动时静默替换；有改动则标 conflicted 提示）
  useEffect(() => {
    if (!currentFile) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const isMacPlatform = navigator.platform.toLowerCase().includes('mac');
      const mod = isMacPlatform ? e.metaKey : e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        refreshCurrentFile().catch((err) => {
          log.error('刷新文件失败', err instanceof Error ? err : new Error(String(err)));
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentFile, refreshCurrentFile]);

  if (!currentFile) return null;

  const isSaving = status === 'saving';
  const isModified = currentFile.isModified;

  // 干净且无冲突时无需展示该行，避免占用空间
  if (!isModified && !isConflicted) return null;

  const handleSave = async () => {
    try {
      await saveFile();
    } catch (error) {
      log.error('Failed to save file:', error instanceof Error ? error : new Error(String(error)));
    }
  };

  return (
    <div className={`flex items-center justify-end px-3 py-1.5 bg-background-elevated border-b border-border-subtle ${className}`}>
      {/* 文件外部修改冲突提示 */}
      {isConflicted && (
        <div className="flex items-center gap-2 mr-auto px-2 py-0.5 rounded bg-warning/10 border border-warning/30 text-warning text-xs">
          <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <span>文件已被外部修改</span>
          <button
            onClick={() => reloadFromDisk()}
            className="px-1.5 py-0.5 rounded hover:bg-warning/20 font-medium transition-colors"
          >
            重新加载
          </button>
          <button
            onClick={() => setConflicted(false)}
            className="px-1.5 py-0.5 rounded hover:bg-warning/20 transition-colors"
          >
            保留当前
          </button>
        </div>
      )}

      {/* 保存按钮（仅在已修改时显示） */}
      {isModified && (
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-primary
                   bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed
                   transition-colors shrink-0"
          title={`保存文件 (${modKey}+S)`}
        >
          {isSaving ? (
            <>
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              保存中...
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
              </svg>
              保存
            </>
          )}
        </button>
      )}
    </div>
  );
}
