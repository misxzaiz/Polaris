/**
 * 任务卡片组件
 */

import { useTranslation } from 'react-i18next';
import type { ScheduledTask, TaskStatus } from '../../types/scheduler';
import { TRIGGER_TYPE_LABELS, formatRelativeTime } from '../../types/scheduler';

/** 状态徽章 */
function StatusBadge({ status, isRunning }: { status?: TaskStatus; isRunning?: boolean }) {
  const { t } = useTranslation('scheduler');

  if (!status) {
    return (
      <span className="px-2 py-0.5 rounded text-xs bg-background-hover text-text-muted">
        {t('status.notExecuted')}
      </span>
    );
  }

  const styles: Record<TaskStatus, string> = {
    running: 'bg-info-faint text-info',
    success: 'bg-success-faint text-success',
    failed: 'bg-danger-faint text-danger',
  };

  const labels: Record<TaskStatus, string> = {
    running: t('status.running'),
    success: t('status.success'),
    failed: t('status.failed'),
  };

  return (
    <span
      className={`px-2 py-0.5 rounded text-xs ${styles[status]} ${
        isRunning && status === 'running' ? 'animate-pulse' : ''
      }`}
    >
      {labels[status]}
    </span>
  );
}

export interface TaskCardProps {
  /** 任务数据 */
  task: ScheduledTask;
  /** 是否正在执行 */
  isRunning?: boolean;
  /** 点击编辑 */
  onEdit: () => void;
  /** 点击复制 */
  onCopy: () => void;
  /** 点击删除 */
  onDelete: () => void;
  /** 点击切换状态 */
  onToggle: () => void;
  /** 点击执行 */
  onRun: () => void;
}

export function TaskCard({
  task,
  isRunning,
  onEdit,
  onCopy,
  onDelete,
  onToggle,
  onRun,
}: TaskCardProps) {
  const { t } = useTranslation('scheduler');

  const isEnabled = task.enabled;
  const showNextRun = isEnabled && task.nextRunAt;

  return (
    <div
      className={`bg-background-surface rounded-xl p-4 border border-border-subtle transition-colors ${
        isEnabled ? 'hover:border-primary/30' : 'opacity-60'
      }`}
    >
      {/* 头部 */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3">
          {/* 状态指示点 */}
          <span
            className={`w-2 h-2 rounded-full mt-2 ${
              isRunning
                ? 'bg-info animate-pulse'
                : isEnabled
                  ? 'bg-success'
                  : 'bg-text-muted'
            }`}
          />
          <div>
            <h3 className="font-medium text-text-primary">{task.name}</h3>
            {task.description && (
              <p className="text-sm text-text-muted mt-0.5">{task.description}</p>
            )}
          </div>
        </div>

        {/* 右侧状态 */}
        <div className="flex items-center gap-3">
          <StatusBadge status={task.lastRunStatus} isRunning={isRunning} />
          {showNextRun && (
            <span className="text-xs text-text-muted">
              {t('card.nextRun')}: {formatRelativeTime(task.nextRunAt)}
            </span>
          )}
        </div>
      </div>

      {/* 信息行 */}
      <div className="mb-3 pt-3 border-t border-border-subtle flex items-center gap-4 text-sm">
        <span className="text-text-muted">
          {t('card.trigger')}:{' '}
          <span className="text-text-secondary">
            {TRIGGER_TYPE_LABELS[task.triggerType]} - {task.triggerValue}
          </span>
        </span>
        <span className="text-text-muted">
          {t('card.engine')}:{' '}
          <span className="text-text-secondary">{task.engineId}</span>
        </span>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-2">
        <button
          onClick={onRun}
          disabled={isRunning}
          className={`px-3 py-1 text-sm rounded transition-colors ${
            isRunning
              ? 'bg-info-faint text-info cursor-wait'
              : 'bg-primary-faint text-primary hover:bg-primary/20'
          }`}
        >
          {isRunning ? t('card.running') : t('card.run')}
        </button>

        <button
          onClick={onToggle}
          className={`px-3 py-1 text-sm rounded transition-colors ${
            isEnabled
              ? 'bg-warning-faint text-warning hover:bg-warning/20'
              : 'bg-success-faint text-success hover:bg-success/20'
          }`}
        >
          {isEnabled ? t('card.disable') : t('card.enable')}
        </button>

        <button
          onClick={onEdit}
          className="px-3 py-1 text-sm bg-background-hover text-text-secondary hover:bg-background-active rounded transition-colors"
        >
          {t('card.edit')}
        </button>

        <button
          onClick={onCopy}
          className="px-3 py-1 text-sm bg-info-faint text-info hover:bg-info/20 rounded transition-colors"
        >
          {t('card.copy')}
        </button>

        <button
          onClick={onDelete}
          className="px-3 py-1 text-sm bg-danger-faint text-danger hover:bg-danger/20 rounded transition-colors"
        >
          {t('card.delete')}
        </button>
      </div>
    </div>
  );
}
