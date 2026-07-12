/**
 * AgentRun 块渲染器组件
 *
 * 用于展示 Agent 任务运行状态、嵌套工具调用和输出
 */

import { memo, useState, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import type { AgentRunBlock } from '@/types';
import {
  formatDuration,
  calculateDuration,
} from '@/utils/toolSummary';
import { Check, XCircle, Loader2, AlertTriangle, ChevronDown, Circle, ListChecks, Play } from 'lucide-react';

// ========================================
// AgentRun 渲染器
// ========================================

/** AgentRun 状态配置 */
const AGENT_STATUS_CONFIG = {
  pending: { icon: Loader2, className: 'animate-spin text-yellow-500', labelKey: 'status.pending' },
  running: { icon: Loader2, className: 'animate-spin text-blue-500', labelKey: 'status.running' },
  success: { icon: Check, className: 'text-green-500', labelKey: 'status.completed' },
  error: { icon: XCircle, className: 'text-red-500', labelKey: 'status.failed' },
  canceled: { icon: XCircle, className: 'text-gray-500', labelKey: 'status.canceled' },
} as const;

/** 嵌套工具调用状态配置 */
const NESTED_TOOL_STATUS_CONFIG = {
  pending: { icon: Circle, color: 'text-gray-400' },
  running: { icon: Loader2, color: 'text-blue-500 animate-spin' },
  completed: { icon: Check, color: 'text-green-500' },
  failed: { icon: XCircle, color: 'text-red-500' },
} as const;

export interface AgentRunBlockRendererProps {
  block: AgentRunBlock;
}

/**
 * AgentRun 块组件 - 用于 Agent 任务聚合展示
 */
export const AgentRunBlockRenderer = memo(function AgentRunBlockRenderer({
  block,
}: AgentRunBlockRendererProps) {
  const { t } = useTranslation('chat');
  const [isExpanded, setIsExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const statusConfig = AGENT_STATUS_CONFIG[block.status];
  const StatusIcon = statusConfig.icon;

  // 计算耗时
  const duration = useMemo(() => {
    if (block.duration) return formatDuration(block.duration);
    const calculated = calculateDuration(block.startedAt, block.completedAt);
    return calculated ? formatDuration(calculated) : '';
  }, [block.duration, block.startedAt, block.completedAt]);

  // 工具调用统计
  const toolStats = useMemo(() => {
    const total = block.toolCalls.length;
    const completed = block.toolCalls.filter(tc => tc.status === 'completed').length;
    const failed = block.toolCalls.filter(tc => tc.status === 'failed').length;
    return { total, completed, failed };
  }, [block.toolCalls]);

  // 是否正在运行
  const isRunning = block.status === 'running';

  // 是否有嵌套工具
  const hasToolCalls = block.toolCalls.length > 0;

  // 键盘导航处理
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsExpanded(prev => !prev);
    }
  }, []);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={t('agent.agentRunAriaLabel', { type: block.agentType })}
      className={clsx(
        'my-2 rounded-lg border overflow-hidden',
        block.status === 'error'
          ? 'bg-error-faint border-error/30'
          : isRunning
            ? 'bg-primary-faint border-primary/30'
            : 'bg-success-faint border-success/30'
      )}
    >
      {/* 头部 */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={t('agent.toggleDetails')}
        className={clsx(
          'flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-inherit/50',
          'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset',
          isRunning && 'animate-pulse-subtle'
        )}
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={handleKeyDown}
      >
        {/* Agent 图标 */}
        <div className={clsx(
          'p-1.5 rounded-md',
          isRunning ? 'bg-primary/20' : block.status === 'error' ? 'bg-error/20' : 'bg-success/20'
        )}>
          <StatusIcon className={clsx('w-4 h-4', statusConfig.className)} />
        </div>

        {/* Agent 信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-text-primary font-medium">{block.agentType}</span>
            <span className={clsx(
              'text-xs px-1.5 py-0.5 rounded',
              isRunning ? 'bg-primary/20 text-primary' :
              block.status === 'error' ? 'bg-error/20 text-error' : 'bg-success/20 text-success'
            )}>
              {t(statusConfig.labelKey)}
            </span>
          </div>
          {/* 进度信息 */}
          {isRunning && block.progressMessage && (
            <div className="text-xs text-text-tertiary mt-0.5 truncate">
              {block.progressMessage}
            </div>
          )}
          {/* 工具调用摘要 */}
          {hasToolCalls && !isExpanded && (
            <div className="text-xs text-text-tertiary mt-0.5">
              {t('agent.toolCount', { count: toolStats.total })}
              {toolStats.completed > 0 && ` (${toolStats.completed} ${t('agent.completed')})`}
            </div>
          )}
        </div>

        {/* 进度条 */}
        {isRunning && block.progressPercent !== undefined && (
          <div className="w-20 flex items-center gap-2">
            <div className="flex-1 bg-bg-secondary rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-primary h-full transition-all duration-300"
                style={{ width: `${block.progressPercent}%` }}
              />
            </div>
            <span className="text-xs text-text-tertiary">{block.progressPercent}%</span>
          </div>
        )}

        {/* 耗时 */}
        {duration && (
          <span className="text-xs text-text-tertiary shrink-0">{duration}</span>
        )}

        {/* 展开/收起 */}
        {hasToolCalls && (
          <ChevronDown
            className={clsx(
              'w-4 h-4 text-text-muted transition-transform shrink-0',
              isExpanded && 'rotate-180'
            )}
          />
        )}
      </div>

      {/* 嵌套工具调用列表 */}
      {isExpanded && hasToolCalls && (
        <div className="px-4 py-2 bg-bg-secondary/30 border-t border-inherit">
          <div className="text-xs text-text-muted mb-2 flex items-center gap-1.5">
            <ListChecks className="w-3 h-3" />
            {t('agent.toolCalls')}
          </div>
          <div className="space-y-1">
            {block.toolCalls.map((toolCall) => {
              const toolConfig = NESTED_TOOL_STATUS_CONFIG[toolCall.status];
              const ToolIcon = toolConfig.icon;
              return (
                <div
                  key={toolCall.id}
                  className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-bg-secondary/50"
                >
                  <ToolIcon className={clsx('w-3 h-3', toolConfig.color)} />
                  <span className="text-text-secondary">{toolCall.name}</span>
                  {toolCall.summary && (
                    <span className="text-text-tertiary truncate flex-1">{toolCall.summary}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 错误信息 */}
      {block.status === 'error' && block.error && (
        <div className="px-3 py-2 border-t border-error/20 bg-error/5">
          <div className="text-xs text-error flex items-start gap-1.5">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
            <span className="break-all">{block.error}</span>
          </div>
        </div>
      )}

      {/* 输出内容 */}
      {block.output && isExpanded && (
        <div className="px-3 py-2 border-t border-inherit bg-inherit/30">
          <div className="text-xs text-text-muted mb-1">{t('agent.output')}</div>
          <pre className="text-xs text-text-secondary bg-bg-secondary rounded p-2 max-h-48 overflow-y-auto whitespace-pre-wrap">
            {block.output}
          </pre>
        </div>
      )}
    </div>
  );
});

/** 简化版 AgentRun 渲染器 - 用于归档层 */
export const SimplifiedAgentRunRenderer = memo(function SimplifiedAgentRunRenderer({ block }: { block: AgentRunBlock }) {
  const { t } = useTranslation('chat');
  const statusConfig = AGENT_STATUS_CONFIG[block.status];
  const StatusIcon = statusConfig.icon;

  return (
    <div
      className="my-1 flex items-center gap-2 text-xs text-text-tertiary"
      aria-label={t('agent.agentRunAriaLabel', { type: block.agentType })}
    >
      <StatusIcon className={clsx('w-3 h-3', statusConfig.className)} aria-hidden="true" />
      <Play className="w-3 h-3 text-primary" aria-hidden="true" />
      <span className="truncate">{block.agentType}</span>
      {block.toolCalls.length > 0 && (
        <span className="text-text-secondary">{block.toolCalls.length}</span>
      )}
    </div>
  );
});

export default AgentRunBlockRenderer;
