/**
 * UnsavedDialog - 未保存更改确认对话框
 *
 * 提供三个选项：保存 / 不保存 / 取消
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { OverlayGuard } from '@/components/Browser/OverlayGuard';
import { Save, FileText } from 'lucide-react';
import { createLogger } from '@/utils/logger';
import { useTransitionState } from '@/hooks/useTransitionState';

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
  // 进出场动画：cancel/dontSave/保存成功 先退场，结束后再执行真实回调
  const { mounted, phase, exit } = useTransitionState({
    duration: 180,
    onExited: () => {
      pendingAction.current?.();
      pendingAction.current = null;
    },
  });
  const pendingAction = useRef<(() => void) | null>(null);

  useEffect(() => {
    // 默认聚焦保存按钮
    if (mounted && saveButtonRef.current) {
      saveButtonRef.current.focus();
    }
  }, [mounted]);

  const handleCancel = () => {
    pendingAction.current = onCancel;
    exit();
  };

  const handleDontSave = () => {
    pendingAction.current = onDontSave;
    exit();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  const handleSave = async () => {
    try {
      await onSave();
      // 保存成功后退场（父组件由 onExited 卸载）
      pendingAction.current = onCancel;
      exit();
    } catch (error) {
      // 保存失败时保持对话框打开，由调用方处理错误
      log.error('Save failed:', error instanceof Error ? error : new Error(String(error)));
    }
  };

  if (!mounted) return null;

  const exiting = phase === 'exiting';

  return (
    <OverlayGuard label="UnsavedDialog">
      <div
        className={`fixed inset-0 flex items-center justify-center z-modal ${exiting ? 'animate-mask-out' : 'animate-mask-in'}`}
        style={{ background: 'rgba(0,0,0,0.5)' }}
        onKeyDown={handleKeyDown}
      >
      <div
        className={`bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-glow ${exiting ? 'animate-dialog-out' : 'animate-dialog-in'}`}
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
            onClick={handleCancel}
            disabled={isSaving}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
          >
            {t('buttons.cancel')}
          </button>

          {/* 不保存 */}
          <button
            type="button"
            onClick={handleDontSave}
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
    </OverlayGuard>
  );
}
