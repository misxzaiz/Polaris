/**
 * 任务卡片组件 - 紧凑布局
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Square, FileText, MoreHorizontal, CheckCircle, XCircle, Circle, Loader2 } from 'lucide-react';
import type { ScheduledTask, TaskStatus } from '@/types/scheduler';
import { formatRelativeTime } from '@/types/scheduler';

/** 状态图标 */
function StatusIcon({ status, isRunning }: { status?: TaskStatus; isRunning?: boolean }) {
  if (isRunning) {
    return <Loader2 size={14} className="text-info animate-spin" />;
  }

  if (!status) {
    return <Circle size={14} className="text-text-muted" />;
  }

  const iconMap: Record<TaskStatus, ReactNode> = {
    running: <Loader2 size={14} className="text-info animate-spin" />,
    success: <CheckCircle size={14} className="text-success" />,
    failed: <XCircle size={14} className="text-danger" />,
  };

  return iconMap[status];
}

export interface TaskCardProps {
  /** 任务数据 */
  task: ScheduledTask;
  /** 是否正在执行 */
  isRunning?: boolean;
  /** 是否已订阅日志 */
  isSubscribed?: boolean;
  /** 点击编辑 */
  onEdit: () => void;
  /** 点击复制 */
  onCopy: () => void;
  /** 点击删除 */
  onDelete: () => void;
  /** 点击切换状态 */
  onToggle: () => void;
  /** 点击执行任务 */
  onRun: () => void;
  /** 点击订阅日志（仅订阅正在执行的任务） */
  onSubscribe: () => void;
  /** 点击查看协议文档 */
  onViewProtocol?: () => void;
}

export function TaskCard({
  task,
  isRunning,
  isSubscribed,
  onEdit,
  onCopy,
  onDelete,
  onToggle,
  onRun,
  onSubscribe,
  onViewProtocol,
}: TaskCardProps) {
  const { t } = useTranslation('scheduler');
  const [showActions, setShowActions] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  const isEnabled = task.enabled;
  const isAfterCompletion = task.triggerType === 'after_completion';
  const triggerDisplay =
    task.triggerType === 'interval' || isAfterCompletion
      ? `${t(`triggerTypes.${task.triggerType}`)} ${task.triggerValue}`
      : task.triggerType === 'cron'
        ? `Cron ${task.triggerValue.slice(0, 8)}`
        : t('triggerTypes.once');

  // 下次执行提示：after_completion 的 nextRunAt 在运行期间无意义
  // （完成时刻未知，存储层保持 None），故该类型改显示「完成后 X」。
  const nextRunNode = (() => {
    if (!task.enabled) return null;
    if (isAfterCompletion) {
      const isPending = isRunning || task.lastRunStatus === 'running';
      return (
        <span
          className={isPending ? 'text-info' : ''}
          title={t('card.afterCompletionHint')}
        >
          {isPending ? t('card.afterCompletionPending', { value: task.triggerValue }) : t('card.afterCompletion', { value: task.triggerValue })}
        </span>
      );
    }
    return task.nextRunAt ? (
      <span>{formatRelativeTime(task.nextRunAt)}</span>
    ) : null;
  })();

  return (
    <div
      className={`relative bg-background-surface rounded-lg border transition-colors ${
        isRunning
          ? 'border-info/40 ring-1 ring-info/20'
          : isEnabled
            ? 'border-border-subtle hover:border-primary/30'
            : 'border-border-subtle opacity-60'
      } ${showMoreMenu ? 'z-30' : ''}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => {
        // 只有在菜单关闭时才关闭 actions
        if (!showMoreMenu) {
          setShowActions(false);
        }
      }}
    >
      {/* 主内容行 - h-12 (48px) */}
      <div className="h-12 px-3 flex items-center justify-between">
        {/* 左侧：状态 + 名称 + 执行中徽标 */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <StatusIcon status={task.lastRunStatus} isRunning={isRunning} />
          <span className="text-sm font-medium text-text-primary truncate">{task.name}</span>
          {isRunning && (
            <span className="inline-flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium text-info bg-info/10">
              <span className="w-1 h-1 rounded-full bg-info animate-pulse" />
              {t('card.running')}
            </span>
          )}
        </div>

        {/* 右侧：触发方式 + 下次执行（hover 时隐藏给操作按钮留空间） */}
        <div className={`flex items-center gap-3 text-xs text-text-muted shrink-0 ml-2 transition-opacity ${showActions ? 'opacity-0' : ''}`}>
          <span className="max-w-20 truncate">{triggerDisplay}</span>
          {nextRunNode}
          {!task.enabled && (
            <span className="text-text-muted">{t('card.disabled')}</span>
          )}
        </div>
      </div>

      {/* Hover 显示的操作按钮 */}
      {showActions && (
        <div
          className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 bg-background-surface px-1 py-0.5 rounded shadow-md border border-border-subtle z-20"
          onMouseEnter={() => setShowActions(true)}
          onMouseLeave={() => {
            if (!showMoreMenu) {
              setShowActions(false);
            }
          }}
        >
          {/* 执行/停止 */}
          {isRunning ? (
            <button
              onClick={onRun}
              disabled
              className="p-1.5 text-info cursor-wait"
              title={t('card.running')}
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              onClick={onRun}
              className="p-1.5 text-primary hover:bg-primary-faint rounded transition-colors"
              title={t('card.runHint')}
            >
              <Play size={14} />
            </button>
          )}

          {/* 日志 */}
          <button
            onClick={onSubscribe}
            disabled={!isRunning || isSubscribed}
            className={`p-1.5 rounded transition-colors ${
              isSubscribed
                ? 'text-success'
                : isRunning
                  ? 'text-text-secondary hover:bg-background-hover hover:text-text-primary'
                  : 'text-text-muted cursor-not-allowed'
            }`}
            title={isRunning ? t('card.subscribeHint') : t('card.subscribeDisabled')}
          >
            <FileText size={14} />
          </button>

          {/* 更多操作 */}
          <div className="relative">
            <button
              onClick={() => setShowMoreMenu(!showMoreMenu)}
              className="p-1.5 text-text-secondary hover:bg-background-hover hover:text-text-primary rounded transition-colors"
            >
              <MoreHorizontal size={14} />
            </button>
            {/* 下拉菜单 - 点击显示/隐藏，紧贴按钮无间隙 */}
            {showMoreMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMoreMenu(false)} />
                <div
                  className="absolute right-0 top-full w-28 bg-background-surface border border-border-subtle rounded-lg shadow-lg z-50 py-1"
                  onMouseEnter={() => setShowActions(true)}
                >
                  <button
                    onClick={() => {
                      onEdit();
                      setShowMoreMenu(false);
                    }}
                    className="w-full px-2 py-1.5 text-left text-xs hover:bg-background-hover text-text-secondary hover:text-text-primary"
                  >
                    {t('card.edit')}
                  </button>
                  <button
                    onClick={() => {
                      onCopy();
                      setShowMoreMenu(false);
                    }}
                    className="w-full px-2 py-1.5 text-left text-xs hover:bg-background-hover text-text-secondary hover:text-text-primary"
                  >
                    {t('card.copy')}
                  </button>
                  {task.mode === 'protocol' && onViewProtocol && (
                    <button
                      onClick={() => {
                        onViewProtocol();
                        setShowMoreMenu(false);
                      }}
                      className="w-full px-2 py-1.5 text-left text-xs hover:bg-background-hover text-text-secondary hover:text-text-primary"
                    >
                      {t('card.viewProtocol')}
                    </button>
                  )}
                  <div className="h-px bg-border-subtle my-1" />
                  <button
                    onClick={() => {
                      onToggle();
                      setShowMoreMenu(false);
                    }}
                    className={`w-full px-2 py-1.5 text-left text-xs hover:bg-background-hover ${
                      isEnabled ? 'text-warning' : 'text-success'
                    }`}
                  >
                    {isEnabled ? t('card.disable') : t('card.enable')}
                  </button>
                  <button
                    onClick={() => {
                      onDelete();
                      setShowMoreMenu(false);
                    }}
                    className="w-full px-2 py-1.5 text-left text-xs hover:bg-background-hover text-danger"
                  >
                    {t('card.delete')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}