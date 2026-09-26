/**
 * 自定义确认对话框组件
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { OverlayGuard } from '@/components/Browser/OverlayGuard';
import { useTransitionState } from '@/hooks/useTransitionState';

interface ConfirmDialogProps {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  type?: 'danger' | 'warning' | 'info';
}

export function ConfirmDialog({
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  type = 'danger',
}: ConfirmDialogProps) {
  const { t } = useTranslation('common');
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const finalConfirmText = confirmText || t('buttons.confirm');
  const finalCancelText = cancelText || t('buttons.cancel');
  // 进出场动画：confirm/cancel 先退场，结束后再执行真实回调
  const { mounted, phase, exit } = useTransitionState({
    duration: 180,
    onExited: () => {
      // 由 exit 时选择的动作决定执行哪个回调
      pendingAction.current?.();
      pendingAction.current = null;
    },
  });
  const pendingAction = useRef<(() => void) | null>(null);

  const handleConfirm = () => {
    pendingAction.current = onConfirm;
    exit();
  };
  const handleCancel = () => {
    pendingAction.current = onCancel;
    exit();
  };

  useEffect(() => {
    if (mounted && confirmButtonRef.current) {
      confirmButtonRef.current.focus();
    }
  }, [mounted]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  const getColorClass = () => {
    switch (type) {
      case 'danger':
        return 'bg-danger hover:bg-danger/90';
      case 'warning':
        return 'bg-warning hover:bg-warning/90';
      case 'info':
        return 'bg-primary hover:bg-primary/90';
      default:
        return 'bg-primary hover:bg-primary/90';
    }
  };

  if (!mounted) return null;

  const exiting = phase === 'exiting';

  return (
    <OverlayGuard label="ConfirmDialog">
      <div
        className={`fixed inset-0 flex items-center justify-center z-50 ${exiting ? 'animate-mask-out' : 'animate-mask-in'}`}
        style={{ background: 'rgba(0,0,0,0.5)' }}
        onKeyDown={handleKeyDown}
      >
      <div className={`bg-background-elevated rounded-xl p-4 sm:p-6 w-full max-w-md border border-border shadow-glow ${exiting ? 'animate-dialog-out' : 'animate-dialog-in'}`}>
        {title && (
          <h2 className="text-lg font-semibold text-text-primary mb-2">
            {title}
          </h2>
        )}

        <p className="text-sm text-text-secondary whitespace-pre-wrap mb-6">
          {message}
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={handleCancel}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors"
          >
            {finalCancelText}
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={handleConfirm}
            className={`px-4 py-2 text-sm text-white rounded-lg transition-colors ${getColorClass()}`}
          >
            {finalConfirmText}
          </button>
        </div>
      </div>
      </div>
    </OverlayGuard>
  );
}
