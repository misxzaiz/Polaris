/**
 * 编辑器顶部栏组件
 */

import { useFileEditorStore } from '../../stores';

interface EditorHeaderProps {
  className?: string;
}

export function EditorHeader({ className = '' }: EditorHeaderProps) {
  const { currentFile, saveFile, closeFile, status } = useFileEditorStore();

  if (!currentFile) return null;

  const isSaving = status === 'saving';
  const isModified = currentFile.isModified;

  const handleSave = async () => {
    try {
      await saveFile();
    } catch (error) {
      console.error('Failed to save file:', error);
    }
  };

  const handleClose = async () => {
    try {
      await closeFile();
    } catch (error) {
      console.error('Failed to close file:', error);
    }
  };

  return (
    <div className={`flex items-center justify-between px-3 py-2 bg-background-elevated border-b border-border-subtle ${className}`}>
      {/* 文件名 */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <svg
          className="w-4 h-4 text-text-tertiary shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <span className="text-sm text-text-primary truncate font-mono">
          {currentFile.name}
          {isModified && <span className="text-warning ml-1">●</span>}
        </span>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-1 shrink-0">
        {isModified && (
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-primary
                     bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed
                     transition-colors"
            title="保存文件 (Cmd+S)"
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

        <button
          onClick={handleClose}
          className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover
                   transition-colors"
          title="关闭文件"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
