/**
 * AgentRun 块渲染器组件
 *
 * 精简设计：agent 运行态由动态岛（Dynamic Island）接管实时展示，
 * 消息流内仅保留极简历史行（状态点 + agentType + 工具数 + 耗时），
 * 不再渲染大面板，避免与动态岛重复、降低信息密度。
 *
 * 可展开查看嵌套工具列表（折叠态单行）。
 */

import { memo, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import type { AgentRunBlock } from '@/types';
import { formatDuration, calculateDuration } from '@/utils/toolSummary';
import { Check, XCircle, Loader2, Circle, ChevronDown, Play } from 'lucide-react';

const AGENT_STATUS_CONFIG = {
  pending: { icon: Loader2, className: 'animate-spin text-yellow-500', labelKey: 'status.pending' },
  running: { icon: Loader2, className: 'animate-spin text-blue-500', labelKey: 'status.running' },
  success: { icon: Check, className: 'text-green-500', labelKey: 'status.completed' },
  error: { icon: XCircle, className: 'text-red-500', labelKey: 'status.failed' },
  canceled: { icon: XCircle, className: 'text-gray-500', labelKey: 'status.canceled' },
} as const;

const NESTED_TOOL_STATUS_CONFIG = {
  pending: { icon: Circle, color: 'text-text-muted' },
  running: { icon: Loader2, color: 'text-blue-500 animate-spin' },
  completed: { icon: Check, color: 'text-green-500' },
  failed: { icon: XCircle, color: 'text-red-500' },
} as const;

export const AgentRunBlockRenderer = memo(function AgentRunBlockRenderer({
  block,
}: { block: AgentRunBlock }) {
  const { t } = useTranslation('chat');
  const [isExpanded, setIsExpanded] = useState(false);

  const statusConfig = AGENT_STATUS_CONFIG[block.status];
  const StatusIcon = statusConfig.icon;
  const isRunning = block.status === 'running';
  const hasToolCalls = block.toolCalls.length > 0;

  const duration = useMemo(() => {
    if (block.duration) return formatDuration(block.duration);
    const calc = calculateDuration(block.startedAt, block.completedAt);
    return calc ? formatDuration(calc) : isRunning ? '运行中' : '';
  }, [block.duration, block.startedAt, block.completedAt, isRunning]);

  const toolDone = block.toolCalls.filter(tc => tc.status === 'completed').length;

  return (
    <div className={clsx(
      'my-1 rounded-md border overflow-hidden',
      block.status === 'error' ? 'border-error/30 bg-error-faint/30' : 'border-border-subtle/40 bg-surface/40',
    )}>
      {/* 精简单行 */}
      <button
        onClick={() => hasToolCalls && setIsExpanded(v => !v)}
        className={clsx(
          'flex items-center gap-2 w-full px-2.5 py-1.5 transition-colors',
          hasToolCalls && 'hover:bg-surface/60 cursor-pointer',
        )}
      >
        <Play size={11} className={clsx('shrink-0', isRunning ? 'text-primary' : 'text-text-muted')} />
        <StatusIcon className={clsx('w-3 h-3 shrink-0', statusConfig.className)} />
        <span className="text-xs text-text-secondary truncate flex-1 text-left">
          {block.agentType}
        </span>
        {/* 工具数 */}
        {hasToolCalls && (
          <span className="text-[10px] text-text-muted shrink-0 tabular-nums">
            {toolDone}/{block.toolCalls.length}
          </span>
        )}
        {/* 耗时 */}
        {duration && (
          <span className="text-[10px] text-text-tertiary shrink-0 tabular-nums">{duration}</span>
        )}
        {/* 错误标记 */}
        {block.status === 'error' && (
          <span className="text-[10px] text-danger shrink-0">{t('status.failed')}</span>
        )}
        {hasToolCalls && (
          <ChevronDown
            size={11}
            className={clsx('text-text-muted shrink-0 transition-transform', isExpanded && 'rotate-180')}
          />
        )}
      </button>

      {/* 展开态：嵌套工具列表 */}
      {isExpanded && hasToolCalls && (
        <div className="px-2 pb-1.5 pt-0.5 border-t border-border-subtle/30 space-y-0.5">
          {block.toolCalls.map(tc => {
            const cfg = NESTED_TOOL_STATUS_CONFIG[tc.status];
            const ToolIcon = cfg.icon;
            return (
              <div key={tc.id} className="flex items-center gap-2 px-1.5 py-0.5 rounded hover:bg-background-hover/50">
                <ToolIcon className={clsx('w-2.5 h-2.5 shrink-0', cfg.color)} />
                <span className="text-[11px] text-text-tertiary truncate flex-1">{tc.name}</span>
                {tc.summary && (
                  <span className="text-[10px] text-text-muted truncate max-w-[50%]">{tc.summary}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 错误详情（仅失败时） */}
      {block.status === 'error' && block.error && (
        <div className="px-2.5 pb-1.5 text-[11px] text-danger/80 break-all border-t border-error/15">
          {block.error}
        </div>
      )}
    </div>
  );
});

/** 简化版 AgentRun 渲染器 - 用于归档层 */
export const SimplifiedAgentRunRenderer = memo(function SimplifiedAgentRunRenderer({ block }: { block: AgentRunBlock }) {
  const statusConfig = AGENT_STATUS_CONFIG[block.status];
  const StatusIcon = statusConfig.icon;
  return (
    <div className="my-0.5 flex items-center gap-1.5 text-[11px] text-text-tertiary">
      <StatusIcon className={clsx('w-2.5 h-2.5', statusConfig.className)} aria-hidden="true" />
      <Play className="w-2.5 h-2.5 text-text-muted" aria-hidden="true" />
      <span className="truncate">{block.agentType}</span>
      {block.toolCalls.length > 0 && (
        <span className="text-text-muted">{block.toolCalls.length}</span>
      )}
    </div>
  );
});

export default AgentRunBlockRenderer;
