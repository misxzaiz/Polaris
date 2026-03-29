/**
 * 调度器控制栏
 */

import { useTranslation } from 'react-i18next';
import { useSchedulerStore, useToastStore } from '../../stores';

/** 状态指示器 */
function StatusIndicator({ isRunning }: { isRunning: boolean }) {
  return (
    <span
      className={`w-2 h-2 rounded-full ${
        isRunning ? 'bg-success animate-pulse' : 'bg-text-muted'
      }`}
    />
  );
}

export function SchedulerControl() {
  const { t } = useTranslation('scheduler');
  const toast = useToastStore();
  const {
    schedulerStatus,
    statusLoading,
    loadSchedulerStatus,
    startScheduler,
    stopScheduler,
  } = useSchedulerStore();

  const handleStart = async () => {
    const success = await startScheduler();
    if (success) {
      toast.success(t('control.startSuccess'));
    } else {
      toast.warning(t('control.startFailed'));
    }
  };

  const handleStop = async () => {
    const success = await stopScheduler();
    if (success) {
      toast.success(t('control.stopSuccess'));
    }
  };

  const handleTryAcquire = async () => {
    const success = await startScheduler();
    if (success) {
      toast.success(t('control.acquireSuccess'));
    } else {
      toast.warning(t('control.acquireFailed'));
    }
  };

  // 刷新状态
  const handleRefresh = () => {
    loadSchedulerStatus();
  };

  const isRunning = schedulerStatus?.isRunning ?? false;
  const isLockedByOther = schedulerStatus?.isLockedByOther ?? false;
  const pid = schedulerStatus?.pid ?? 0;

  return (
    <div className="px-4 py-3 bg-background-surface border-b border-border-subtle">
      <div className="flex items-center justify-between">
        {/* 左侧：状态显示 */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <StatusIndicator isRunning={isRunning} />
            <span className="text-sm text-text-secondary">
              {isRunning
                ? t('control.running')
                : isLockedByOther
                  ? t('control.lockedByOther')
                  : t('control.stopped')}
            </span>
          </div>

          {/* PID 信息 */}
          <div className="text-xs text-text-muted bg-background-hover px-2 py-1 rounded">
            PID: <span className="text-text-secondary">{pid}</span>
          </div>

          {/* 刷新按钮 */}
          <button
            onClick={handleRefresh}
            className="text-text-muted hover:text-text-primary transition-colors"
            title={t('control.refresh')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M14 8C14 11.3137 11.3137 14 8 14C4.68629 14 2 11.3137 2 8C2 4.68629 4.68629 2 8 2C10.2091 2 12.1364 3.20883 13.1973 5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <path d="M14 2V5H11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* 右侧：操作按钮 */}
        <div className="flex items-center gap-2">
          {isRunning ? (
            <button
              onClick={handleStop}
              disabled={statusLoading}
              className="px-3 py-1.5 text-sm bg-danger-faint text-danger hover:bg-danger/20 rounded-lg transition-colors disabled:opacity-50"
            >
              {t('control.stop')}
            </button>
          ) : isLockedByOther ? (
            <button
              onClick={handleTryAcquire}
              disabled={statusLoading}
              className="px-3 py-1.5 text-sm bg-primary-faint text-primary hover:bg-primary/20 rounded-lg transition-colors disabled:opacity-50"
            >
              {t('control.tryAcquire')}
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={statusLoading}
              className="px-3 py-1.5 text-sm bg-success-faint text-success hover:bg-success/20 rounded-lg transition-colors disabled:opacity-50"
            >
              {t('control.start')}
            </button>
          )}
        </div>
      </div>

      {/* 多实例冲突提示 */}
      {isLockedByOther && (
        <div className="mt-3 p-3 bg-warning-faint border border-warning/30 rounded-lg">
          <div className="flex items-center gap-2 text-warning">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M8 16A8 8 0 108 0a8 8 0 000 16zM7 5a1 1 0 112 0v3a1 1 0 11-2 0V5zm1 7a1 1 0 100-2 1 1 0 000 2z"
                clipRule="evenodd"
              />
            </svg>
            <span className="text-sm">{t('control.conflictWarning')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
