/**
 * NodeStatusCard Component
 * 节点状态卡片组件
 */

import clsx from 'clsx';
import type { NodeStatusCardProps } from './types';
import { getNodeStatusConfig } from './types';

/**
 * 节点状态卡片
 * 显示单个节点的执行状态和详细信息
 */
export function NodeStatusCard({
  node,
  duration,
  tokenUsage,
  outputSummary,
  errorMessage,
  selected = false,
  onClick,
  className,
}: NodeStatusCardProps) {
  const config = getNodeStatusConfig(node.state);

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const formatTokens = (tokens: number): string => {
    if (tokens < 1000) return tokens.toString();
    if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
    return `${(tokens / 1000000).toFixed(2)}M`;
  };

  return (
    <div
      onClick={onClick}
      className={clsx(
        'rounded-lg border p-3 transition-all duration-200 cursor-pointer',
        config.borderColor,
        config.bgColor,
        {
          'ring-2 ring-blue-500 ring-offset-2': selected,
          'hover:shadow-md': !selected,
        },
        className
      )}
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onClick?.();
        }
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={clsx('text-lg', config.color)}>{config.icon}</span>
          <div>
            <h4 className="font-medium text-gray-900 text-sm">{node.name}</h4>
            <span className="text-xs text-gray-500">{node.role}</span>
          </div>
        </div>
        <StatusBadge state={node.state} config={config} />
      </div>

      {/* Progress */}
      {node.maxRounds > 1 && (
        <div className="mb-2">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
            <span>执行轮次</span>
            <span>
              {node.currentRound} / {node.maxRounds}
            </span>
          </div>
          <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{
                width: `${((node.currentRound ?? 0) / node.maxRounds) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="flex items-center gap-4 text-xs text-gray-600">
        {duration !== undefined && (
          <div className="flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{formatDuration(duration)}</span>
          </div>
        )}
        {tokenUsage && (
          <div className="flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
            </svg>
            <span>
              {formatTokens(tokenUsage.input + tokenUsage.output)} tokens
            </span>
          </div>
        )}
      </div>

      {/* Output summary */}
      {outputSummary && (
        <div className="mt-2 p-2 bg-white/50 rounded text-xs text-gray-600 line-clamp-2">
          {outputSummary}
        </div>
      )}

      {/* Error message */}
      {errorMessage && (
        <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-600">
          <span className="font-medium">错误: </span>
          {errorMessage}
        </div>
      )}
    </div>
  );
}

/**
 * 状态徽章
 */
function StatusBadge({
  config,
}: {
  state: string;
  config: ReturnType<typeof getNodeStatusConfig>;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
        config.bgColor,
        config.color
      )}
    >
      {config.label}
    </span>
  );
}

/**
 * 节点状态迷你卡片
 * 紧凑型显示，用于列表或网格
 */
export function NodeStatusMiniCard({
  node,
  selected = false,
  onClick,
  className,
}: {
  node: { id: string; name: string; state: string; role: string };
  selected?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const config = getNodeStatusConfig(node.state as Parameters<typeof getNodeStatusConfig>[0]);

  return (
    <div
      onClick={onClick}
      className={clsx(
        'flex items-center gap-2 px-2 py-1.5 rounded border transition-all cursor-pointer',
        config.borderColor,
        config.bgColor,
        {
          'ring-2 ring-blue-500': selected,
          'hover:shadow-sm': !selected,
        },
        className
      )}
    >
      <span className={clsx('text-sm', config.color)}>{config.icon}</span>
      <span className="text-xs font-medium text-gray-700 truncate">
        {node.name}
      </span>
    </div>
  );
}

/**
 * 节点状态网格
 */
export function NodeStatusGrid({
  nodes,
  selectedNodeId,
  onNodeClick,
  className,
}: {
  nodes: Array<{ id: string; name: string; state: string; role: string }>;
  selectedNodeId?: string;
  onNodeClick?: (nodeId: string) => void;
  className?: string;
}) {
  return (
    <div className={clsx('grid grid-cols-2 gap-2', className)}>
      {nodes.map((node) => (
        <NodeStatusMiniCard
          key={node.id}
          node={node}
          selected={selectedNodeId === node.id}
          onClick={() => onNodeClick?.(node.id)}
        />
      ))}
    </div>
  );
}

/**
 * 节点状态列表
 */
export function NodeStatusList({
  nodes,
  selectedNodeId,
  onNodeClick,
  className,
}: {
  nodes: Array<{
    id: string;
    name: string;
    state: string;
    role: string;
    duration?: number;
    tokenUsage?: { input: number; output: number };
  }>;
  selectedNodeId?: string;
  onNodeClick?: (nodeId: string) => void;
  className?: string;
}) {
  return (
    <div className={clsx('space-y-2', className)}>
      {nodes.map((node) => (
        <NodeStatusMiniCard
          key={node.id}
          node={node}
          selected={selectedNodeId === node.id}
          onClick={() => onNodeClick?.(node.id)}
        />
      ))}
    </div>
  );
}
