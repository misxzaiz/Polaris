/**
 * ProgressBar Component
 * 工作流进度条组件
 */

import clsx from 'clsx';
import type { ProgressBarProps } from './types';

/**
 * 进度条组件
 * 显示工作流节点的执行进度
 */
export function ProgressBar({
  progress,
  height = 'md',
  showLabels = true,
  showPercentage = true,
  className,
}: ProgressBarProps) {
  const heightClasses = {
    sm: 'h-1.5',
    md: 'h-2.5',
    lg: 'h-4',
  };

  const { segments } = progress.bar;

  return (
    <div className={clsx('w-full', className)}>
      {/* Progress bar */}
      <div
        className={clsx(
          'w-full rounded-full bg-gray-200 overflow-hidden flex',
          heightClasses[height]
        )}
        role="progressbar"
        aria-valuenow={progress.percentage}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {segments.map((segment, index) => (
          <div
            key={`${segment.status}-${index}`}
            className={clsx(
              'h-full transition-all duration-300',
              segment.colorClass,
              {
                // Colors based on status
                'bg-green-500': segment.status === 'completed',
                'bg-amber-500': segment.status === 'running',
                'bg-gray-400': segment.status === 'pending',
                'bg-red-500': segment.status === 'failed',
                'bg-gray-300': segment.status === 'skipped',
              }
            )}
            style={{ width: `${segment.percentage}%` }}
            title={`${segment.status}: ${segment.count} (${segment.percentage.toFixed(1)}%)`}
          />
        ))}
      </div>

      {/* Labels */}
      {showLabels && (
        <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
          <div className="flex items-center gap-3">
            <StatusBadge status="completed" count={progress.completed} />
            <StatusBadge status="running" count={progress.running} />
            <StatusBadge status="pending" count={progress.pending} />
            {progress.failed > 0 && (
              <StatusBadge status="failed" count={progress.failed} />
            )}
            {progress.skipped > 0 && (
              <StatusBadge status="skipped" count={progress.skipped} />
            )}
          </div>
          {showPercentage && (
            <span className="font-medium text-gray-700">
              {progress.percentage.toFixed(1)}%
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 状态徽章
 */
function StatusBadge({
  status,
  count,
}: {
  status: string;
  count: number;
}) {
  const colors: Record<string, string> = {
    completed: 'bg-green-100 text-green-700',
    running: 'bg-amber-100 text-amber-700',
    pending: 'bg-gray-100 text-gray-600',
    failed: 'bg-red-100 text-red-700',
    skipped: 'bg-gray-100 text-gray-500',
  };

  const labels: Record<string, string> = {
    completed: '完成',
    running: '运行',
    pending: '等待',
    failed: '失败',
    skipped: '跳过',
  };

  return (
    <span
      className={clsx(
        'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium',
        colors[status]
      )}
    >
      <span className="mr-1">{labels[status]}</span>
      <span>{count}</span>
    </span>
  );
}

/**
 * 简单进度条
 * 只显示百分比进度
 */
export function SimpleProgressBar({
  percentage,
  color = 'bg-blue-500',
  height = 'md',
  showLabel = false,
  className,
}: {
  percentage: number;
  color?: string;
  height?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  className?: string;
}) {
  const heightClasses = {
    sm: 'h-1',
    md: 'h-2',
    lg: 'h-3',
  };

  const clampedPercentage = Math.min(100, Math.max(0, percentage));

  return (
    <div className={clsx('w-full', className)}>
      <div
        className={clsx(
          'w-full rounded-full bg-gray-200 overflow-hidden',
          heightClasses[height]
        )}
      >
        <div
          className={clsx(
            'h-full rounded-full transition-all duration-300',
            color
          )}
          style={{ width: `${clampedPercentage}%` }}
        />
      </div>
      {showLabel && (
        <span className="text-xs text-gray-500 mt-1">
          {clampedPercentage.toFixed(1)}%
        </span>
      )}
    </div>
  );
}

/**
 * 环形进度条
 */
export function CircularProgress({
  percentage,
  size = 80,
  strokeWidth = 8,
  color = '#3B82F6',
  backgroundColor = '#E5E7EB',
  showLabel = true,
  className,
}: {
  percentage: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  backgroundColor?: string;
  showLabel?: boolean;
  className?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const clampedPercentage = Math.min(100, Math.max(0, percentage));
  const offset = circumference - (clampedPercentage / 100) * circumference;

  return (
    <div className={clsx('relative inline-flex items-center justify-center', className)}>
      <svg width={size} height={size} className="transform -rotate-90">
        {/* Background circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={backgroundColor}
          strokeWidth={strokeWidth}
        />
        {/* Progress circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-300"
        />
      </svg>
      {showLabel && (
        <span className="absolute text-sm font-medium text-gray-700">
          {Math.round(clampedPercentage)}%
        </span>
      )}
    </div>
  );
}
