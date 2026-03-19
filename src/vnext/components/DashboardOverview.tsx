/**
 * DashboardOverview Component
 * 仪表板概览组件
 */

import clsx from 'clsx';
import type {
  DashboardOverviewProps,
  TokenSummaryCardProps,
  CostSummaryCardProps,
} from './types';
import { ProgressBar } from './ProgressBar';

/**
 * 仪表板概览
 * 显示工作流的综合状态信息
 */
export function DashboardOverview({
  data,
  showCost = true,
  showTokens = true,
  showErrors = true,
  onRefresh,
  className,
}: DashboardOverviewProps) {
  return (
    <div className={clsx('bg-white rounded-lg shadow-sm border border-gray-200', className)}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 className="font-medium text-gray-900">{data.workflowName}</h3>
          <span className="text-xs text-gray-500">{data.workflowId}</span>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={data.status} />
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
              title="刷新"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-4 space-y-4">
        {/* Progress */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">执行进度</span>
            <span className="text-xs text-gray-500">{data.duration}</span>
          </div>
          <ProgressBar progress={data.progress} height="md" />
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-3">
          {/* Tokens */}
          {showTokens && (
            <TokenSummaryCard
              summary={data.tokenSummary}
              showDetails={false}
              className="bg-gray-50"
            />
          )}

          {/* Cost */}
          {showCost && (
            <CostSummaryCard
              summary={data.costSummary}
              className="bg-gray-50"
            />
          )}
        </div>

        {/* Errors */}
        {showErrors && data.errorStats.total > 0 && (
          <ErrorSummaryCard
            total={data.errorStats.total}
            rate={data.errorStats.rate}
            recent={data.errorStats.recent}
          />
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 bg-gray-50 rounded-b-lg text-xs text-gray-500">
        最后更新: {data.lastUpdated}
      </div>
    </div>
  );
}

/**
 * 状态徽章
 */
function StatusBadge({ status }: { status: string }) {
  const configs: Record<string, { color: string; bg: string; label: string }> = {
    idle: { color: 'text-gray-600', bg: 'bg-gray-100', label: '空闲' },
    running: { color: 'text-amber-600', bg: 'bg-amber-100', label: '运行中' },
    paused: { color: 'text-blue-600', bg: 'bg-blue-100', label: '已暂停' },
    stopped: { color: 'text-gray-600', bg: 'bg-gray-100', label: '已停止' },
    completed: { color: 'text-green-600', bg: 'bg-green-100', label: '已完成' },
    failed: { color: 'text-red-600', bg: 'bg-red-100', label: '已失败' },
  };

  const config = configs[status] || configs.idle;

  return (
    <span
      className={clsx(
        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
        config.bg,
        config.color
      )}
    >
      {config.label}
    </span>
  );
}

/**
 * Token 摘要卡片
 */
export function TokenSummaryCard({
  summary,
  showDetails = true,
  className,
}: TokenSummaryCardProps) {
  return (
    <div className={clsx('rounded-lg p-3', className)}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500">Token 使用</span>
        <span className="text-sm font-semibold text-gray-900">
          {summary.formatted.total}
        </span>
      </div>
      {showDetails && (
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span>
            <span className="text-gray-400">输入:</span> {summary.formatted.input}
          </span>
          <span>
            <span className="text-gray-400">输出:</span> {summary.formatted.output}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * 成本摘要卡片
 */
export function CostSummaryCard({
  summary,
  currencySymbol = '$',
  className,
}: CostSummaryCardProps) {
  return (
    <div className={clsx('rounded-lg p-3', className)}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500">预估成本</span>
        <span className="text-sm font-semibold text-gray-900">
          {currencySymbol}{summary.formatted.totalCost}
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs text-gray-500">
        <span>
          <span className="text-gray-400">输入:</span> {currencySymbol}{summary.formatted.inputCost}
        </span>
        <span>
          <span className="text-gray-400">输出:</span> {currencySymbol}{summary.formatted.outputCost}
        </span>
      </div>
    </div>
  );
}

/**
 * 错误摘要卡片
 */
function ErrorSummaryCard({
  total,
  rate,
  recent,
}: {
  total: number;
  rate: number;
  recent: Array<{ nodeId: string; nodeName: string; message: string; timestamp: string }>;
}) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-sm font-medium text-red-700">
            {total} 个错误
          </span>
        </div>
        <span className="text-xs text-red-500">
          错误率: {rate.toFixed(1)}%
        </span>
      </div>
      {recent.length > 0 && (
        <div className="mt-2 space-y-1">
          {recent.slice(0, 3).map((error, index) => (
            <div
              key={index}
              className="text-xs text-red-600 bg-white/50 rounded px-2 py-1 truncate"
            >
              <span className="font-medium">{error.nodeName}:</span> {error.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 统计卡片组
 */
export function StatsCardGroup({
  stats,
  className,
}: {
  stats: Array<{
    label: string;
    value: string | number;
    subtitle?: string;
    icon?: React.ReactNode;
    color?: string;
  }>;
  className?: string;
}) {
  return (
    <div className={clsx('grid gap-3', className)}>
      {stats.map((stat, index) => (
        <div
          key={index}
          className="bg-white rounded-lg border border-gray-200 p-3 flex items-center gap-3"
        >
          {stat.icon && (
            <div
              className={clsx(
                'w-10 h-10 rounded-lg flex items-center justify-center',
                stat.color || 'bg-blue-100'
              )}
            >
              {stat.icon}
            </div>
          )}
          <div>
            <div className="text-sm font-medium text-gray-900">{stat.value}</div>
            <div className="text-xs text-gray-500">{stat.label}</div>
            {stat.subtitle && (
              <div className="text-xs text-gray-400">{stat.subtitle}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 快速统计栏
 */
export function QuickStatsBar({
  stats,
  className,
}: {
  stats: Array<{
    label: string;
    value: string | number;
    color?: string;
  }>;
  className?: string;
}) {
  return (
    <div className={clsx('flex items-center gap-4', className)}>
      {stats.map((stat, index) => (
        <div key={index} className="flex items-center gap-2">
          <div
            className={clsx(
              'w-1.5 h-4 rounded-full',
              stat.color || 'bg-gray-400'
            )}
          />
          <div>
            <span className="text-sm font-semibold text-gray-900">{stat.value}</span>
            <span className="text-xs text-gray-500 ml-1">{stat.label}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
