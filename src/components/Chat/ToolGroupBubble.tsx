/**
 * ToolGroupBubble - 工具组消息组件
 *
 * 将多个工具调用聚合展示，支持折叠/展开
 */

import { memo, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { type ToolGroupChatMessage, type ToolChatMessage } from '@/types';
import { formatDuration, calculateToolGroupStatus } from '@/utils/toolSummary';
import { getToolStatusIcon, getToolStatusColor } from '@/utils/toolStatusHelpers';
import { IconChevronRight, IconChevronDown } from '../Common/Icons';
import { clsx } from 'clsx';

interface ToolGroupBubbleProps {
  message: ToolGroupChatMessage;
  /** 工具组包含的工具消息列表 */
  tools: ToolChatMessage[];
}

/** 单个工具项展示 */
const ToolItem = memo(function ToolItem({ tool }: { tool: ToolChatMessage }) {
  const StatusIcon = getToolStatusIcon(tool.status);

  const duration = tool.duration ||
    (tool.completedAt ? formatDuration(
      new Date(tool.completedAt).getTime() - new Date(tool.startedAt).getTime()
    ) : undefined);

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-background-surface border border-border-subtle">
      {StatusIcon && (
        <div className={clsx("shrink-0", getToolStatusColor(tool.status))}>
          <StatusIcon size={12} />
        </div>
      )}
      <span className="text-sm text-text-secondary flex-1 truncate">
        {tool.summary}
      </span>
      {duration && (
        <span className="text-xs text-text-tertiary shrink-0">
          {duration}
        </span>
      )}
    </div>
  );
});

export const ToolGroupBubble = memo(function ToolGroupBubble({
  message,
  tools
}: ToolGroupBubbleProps) {
  const { t } = useTranslation('chat');
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAllTools, setShowAllTools] = useState(false);

  // 计算组状态（可能比 message.status 更新）
  const groupStatus = useMemo(() => {
    return calculateToolGroupStatus(tools);
  }, [tools]);

  const StatusIcon = getToolStatusIcon(groupStatus);

  // 计算时长
  const duration = message.duration ||
    (message.completedAt ? formatDuration(
      new Date(message.completedAt).getTime() - new Date(message.startedAt).getTime()
    ) : undefined);

  // 显示的工具列表（默认最多显示 3 个）
  const displayedTools = showAllTools ? tools : tools.slice(0, 3);
  const hasMoreTools = tools.length > 3;

  // 统计各状态工具数量
  const stats = useMemo(() => {
    const completed = tools.filter(t => t.status === 'completed').length;
    const failed = tools.filter(t => t.status === 'failed').length;
    const running = tools.filter(t => t.status === 'running').length;
    return { completed, failed, running };
  }, [tools]);

  return (
    <div className="my-2">
      {/* 工具组摘要 */}
      <div
        className={clsx(
          "flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all hover:shadow-medium",
          groupStatus === 'running' && "bg-warning-faint border-warning/30",
          groupStatus === 'completed' && "bg-success-faint border-success/30",
          (groupStatus === 'failed' || groupStatus === 'partial') && "bg-warning-faint border-warning/30",
          groupStatus === 'pending' && "bg-background-surface border-border",
        )}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {/* 状态图标 */}
        {StatusIcon && (
          <div className={clsx("shrink-0", getToolStatusColor(groupStatus))}>
            <StatusIcon size={14} />
          </div>
        )}

        {/* 摘要内容 */}
        <div className="flex-1">
          <span className={clsx(
            "text-sm",
            groupStatus === 'running' ? "text-text-primary" : "text-text-secondary"
          )}>
            {message.summary}
          </span>

          {/* 状态统计 */}
          {tools.length > 0 && (
            <span className="ml-2 text-xs text-text-tertiary">
              {stats.completed > 0 && `${stats.completed} ${t('toolGroup.completed')}`}
              {stats.running > 0 && ` ${stats.running} ${t('toolGroup.running')}`}
              {stats.failed > 0 && ` ${stats.failed} ${t('toolGroup.failed')}`}
            </span>
          )}
        </div>

        {/* 时长 */}
        {duration && (
          <span className="text-xs text-text-tertiary">
            {duration}
          </span>
        )}

        {/* 展开/折叠图标 */}
        <div className="shrink-0 text-text-subtle">
          {isExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        </div>
      </div>

      {/* 展开后的工具列表 */}
      {isExpanded && tools.length > 0 && (
        <div className="mt-2 ml-4 space-y-1.5">
          {displayedTools.map((tool) => (
            <ToolItem key={tool.id} tool={tool} />
          ))}

          {/* 显示更多按钮 */}
          {hasMoreTools && !showAllTools && (
            <button
              onClick={() => setShowAllTools(true)}
              className="w-full px-3 py-2 text-xs text-primary hover:text-primary-hover hover:bg-background-hover rounded-md transition-colors"
            >
              {t('toolGroup.showAll', { count: tools.length })}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
