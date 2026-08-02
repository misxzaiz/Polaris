/**
 * UnsavedDialog - 未保存更改确认对话框
 *
 * 提供三个选项：保存 / 不保存 / 取消
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, FileText } from 'lucide-react';
import { createLogger } from '@/utils/logger';

const log = createLogger('UnsavedDialog');

interface UnsavedDialogProps {
  /** 文件名 */
  fileName: string;
  /** 保存回调 */
  onSave: () => Promise<void>;
  /** 不保存回调 */
  onDontSave: () => void;
  /** 取消回调 */
  onCancel: () => void;
  /** 是否正在保存中 */
  isSaving?: boolean;
}

export function UnsavedDialog({
  fileName,
  onSave,
  onDontSave,
  onCancel,
  isSaving = false,
}: UnsavedDialogProps) {
  const { t } = useTranslation('common');
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 默认聚焦保存按钮
    if (saveButtonRef.current) {
      saveButtonRef.current.focus();
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const handleSave = async () => {
    try {
      await onSave();
    } catch (error) {
      // 保存失败时保持对话框打开，由调用方处理错误
      log.error('Save failed:', error instanceof Error ? error : new Error(String(error)));
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-glow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-dialog-title"
      >
        {/* 标题 */}
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-warning/10 rounded-lg">
            <FileText size={20} className="text-warning" />
          </div>
          <h2
            id="unsaved-dialog-title"
            className="text-lg font-semibold text-text-primary"
          >
            {t('tabs.unsavedChanges')}
          </h2>
        </div>

        {/* 消息 */}
        <p className="text-sm text-text-secondary mb-6">
          {t('tabs.unsavedChangesMessage', { name: fileName })}
        </p>

        {/* 按钮组 */}
        <div className="flex justify-end gap-2">
          {/* 取消 */}
          <button
            type="button"
            onClick={onCancel}
            disabled={isSaving}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
          >
            {t('buttons.cancel')}
          </button>

          {/* 不保存 */}
          <button
            type="button"
            onClick={onDontSave}
            disabled={isSaving}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
          >
            {t('tabs.dontSave')}
          </button>

          {/* 保存 */}
          <button
            ref={saveButtonRef}
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="px-4 py-2 text-sm text-white bg-primary hover:bg-primary/90 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isSaving ? (
              <>
                <span className="animate-spin">⏳</span>
                {t('status.saving')}
              </>
            ) : (
              <>
                <Save size={14} />
                {t('tabs.save')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
