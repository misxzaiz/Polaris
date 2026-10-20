/**
 * 自定义确认对话框组件
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
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
  /**
   * AI-7 危护 v1（纯本地确定性预报，0 token）：
   * 「将失去什么」条目列表——由调用方用其域内数据合成（如文件数/提交数）。
   * 提供后渲染红色损失预告块。
   */
  losses?: string[];
  /** 安全网建议（如「已自动生成可撤销快照」「先建备份分支」） */
  safetyNet?: string;
}

export function ConfirmDialog({
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  type = 'danger',
  losses,
  safetyNet,
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
        className={`fixed inset-0 flex items-center justify-center z-modal ${exiting ? 'animate-mask-out' : 'animate-mask-in'}`}
        style={{ background: 'rgba(0,0,0,0.5)' }}
        onKeyDown={handleKeyDown}
      >
      <div className={`bg-background-elevated rounded-xl p-4 sm:p-6 w-full max-w-md border border-border shadow-glow ${exiting ? 'animate-dialog-out' : 'animate-dialog-in'}`}>
        {title && (
          <h2 className="text-lg font-semibold text-text-primary mb-2">
            {title}
          </h2>
        )}

        <p className={`text-sm text-text-secondary whitespace-pre-wrap ${losses?.length ? 'mb-4' : 'mb-6'}`}>
          {message}
        </p>

        {losses && losses.length > 0 && (
          <div className={`${safetyNet ? 'mb-4' : 'mb-6'} rounded-lg border border-danger/30 bg-danger/5 p-3`}>
            <div className="text-xs font-semibold text-danger mb-1.5 flex items-center gap-1.5">
              <AlertTriangle size={13} />
              {t('lossesHeading')}
            </div>
            <ul className="space-y-1">
              {losses.map((loss, i) => (
                <li key={i} className="text-xs text-text-secondary whitespace-pre-wrap break-all">
                  {loss}
                </li>
              ))}
            </ul>
          </div>
        )}

        {safetyNet && (
          <div className="mb-6 rounded-lg border border-primary/25 bg-primary/5 p-3 flex gap-1.5">
            <ShieldCheck size={13} className="text-primary shrink-0 mt-0.5" />
            <span className="text-xs text-text-secondary whitespace-pre-wrap break-all">{safetyNet}</span>
          </div>
        )}

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
