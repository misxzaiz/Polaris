/**
 * 编辑器顶部栏组件
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFileEditorStore } from '@/stores';
import { createLogger } from '@/utils/logger';
import { modKey } from '@/utils/path';

const log = createLogger('EditorHeader');

interface EditorHeaderProps {
  className?: string;
}

export function EditorHeader({ className = '' }: EditorHeaderProps) {
  const { t } = useTranslation('fileExplorer');
  const { currentFile, saveFile, closeFile, status, isConflicted, reloadFromDisk, setConflicted } = useFileEditorStore();
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  // 聚焦到保存按钮
  useEffect(() => {
    if (showCloseConfirm && saveButtonRef.current) {
      saveButtonRef.current.focus();
    }
  }, [showCloseConfirm]);

  if (!currentFile) return null;

  const isSaving = status === 'saving';
  const isModified = currentFile.isModified;

  const handleSave = async () => {
    try {
      await saveFile();
    } catch (error) {
      log.error('Failed to save file:', error instanceof Error ? error : new Error(String(error)));
    }
  };

  const handleCloseClick = () => {
    if (isModified) {
      setShowCloseConfirm(true);
    } else {
      closeFile();
    }
  };

  const handleDiscardClose = async () => {
    setShowCloseConfirm(false);
    try {
      await closeFile();
    } catch (error) {
      log.error('Failed to close file:', error instanceof Error ? error : new Error(String(error)));
    }
  };

  const handleCancelClose = () => {
    setShowCloseConfirm(false);
  };

  const handleSaveAndClose = async () => {
    setShowCloseConfirm(false);
    try {
      await saveFile();
      await closeFile();
    } catch (error) {
      log.error('Failed to save and close:', error instanceof Error ? error : new Error(String(error)));
    }
  };

  const handleDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelClose();
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

      {/* 操作按钮 */}
      <div className="flex items-center gap-1 shrink-0">
        {isModified && (
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-primary
                     bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed
                     transition-colors"
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

        <button
          onClick={handleCloseClick}
          className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover
                   transition-colors"
          title="关闭文件"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* 未保存确认对话框 */}
      {showCloseConfirm && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onKeyDown={handleDialogKeyDown}
        >
          <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-glow">
            <h2 className="text-lg font-semibold text-text-primary mb-2">
              {t('unsavedChanges.title')}
            </h2>

            <p className="text-sm text-text-secondary whitespace-pre-wrap mb-6">
              {t('unsavedChanges.message')}
            </p>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelClose}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors"
              >
                {t('unsavedChanges.cancel')}
              </button>
              <button
                type="button"
                onClick={handleDiscardClose}
                className="px-4 py-2 text-sm text-white rounded-lg bg-danger hover:bg-danger/90 transition-colors"
              >
                {t('unsavedChanges.discard')}
              </button>
              <button
                ref={saveButtonRef}
                type="button"
                onClick={handleSaveAndClose}
                className="px-4 py-2 text-sm text-white rounded-lg bg-primary hover:bg-primary/90 transition-colors"
              >
                {t('unsavedChanges.saveAndClose')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
