/**
 * TimelineView Component
 * 时间线视图组件
 */

import { useMemo } from 'react';
import clsx from 'clsx';
import type { TimelineViewProps, TimelineEventItemProps } from './types';
import { getTimelineEventTypeConfig } from './types';
import type { TimelineEvent } from '../monitor/visualization-types';

/**
 * 时间线视图
 */
export function TimelineView({
  data,
  autoScroll = false,
  maxEvents,
  onEventClick,
  className,
}: TimelineViewProps) {
  const events = useMemo(() => {
    if (!maxEvents) return data.events;
    return data.events.slice(-maxEvents);
  }, [data.events, maxEvents]);

  return (
    <div className={clsx('bg-white rounded-lg border border-gray-200', className)}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h3 className="font-medium text-gray-900">执行时间线</h3>
        <span className="text-xs text-gray-500">
          {events.length} 个事件
        </span>
      </div>

      {/* Timeline */}
      <div className="p-4 max-h-96 overflow-y-auto">
        {events.length === 0 ? (
          <div className="text-center text-gray-400 py-8">
            暂无事件记录
          </div>
        ) : (
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-3 top-0 bottom-0 w-0.5 bg-gray-200" />

            {/* Events */}
            <div className="space-y-3">
              {events.map((event, index) => (
                <TimelineEventItem
                  key={event.id}
                  event={event}
                  onClick={() => onEventClick?.(event)}
                  isLast={index === events.length - 1}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 时间线事件项
 */
function TimelineEventItem({
  event,
  onClick,
  isLast,
  className,
}: TimelineEventItemProps & { isLast?: boolean }) {
  const config = getTimelineEventTypeConfig(event.type);

  return (
    <div
      onClick={onClick}
      className={clsx(
        'relative pl-8 cursor-pointer group',
        className
      )}
    >
      {/* Dot */}
      <div
        className={clsx(
          'absolute left-0 top-1 w-6 h-6 rounded-full flex items-center justify-center',
          config.bgColor
        )}
      >
        <span className={clsx('text-xs', config.color)}>{config.icon}</span>
      </div>

      {/* Content */}
      <div className="bg-gray-50 rounded-lg p-3 group-hover:bg-gray-100 transition-colors">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-900">
                {event.title}
              </span>
              {event.nodeName && (
                <span className="text-xs text-gray-500 bg-white px-1.5 py-0.5 rounded">
                  {event.nodeName}
                </span>
              )}
            </div>
            {event.description && (
              <p className="text-xs text-gray-600 mt-1 line-clamp-2">
                {event.description}
              </p>
            )}
          </div>
          <div className="text-right shrink-0">
            <span className="text-xs text-gray-400">{event.formattedTime}</span>
            {event.formattedDuration && (
              <div className="text-xs text-gray-500">
                {event.formattedDuration}
              </div>
            )}
          </div>
        </div>

        {/* Metadata */}
        {event.metadata && Object.keys(event.metadata).length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-200">
            <MetadataDisplay metadata={event.metadata} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 元数据显示
 */
function MetadataDisplay({ metadata }: { metadata: Record<string, unknown> }) {
  return (
    <div className="flex flex-wrap gap-2">
      {Object.entries(metadata).map(([key, value]) => (
        <span
          key={key}
          className="text-xs bg-white text-gray-600 px-1.5 py-0.5 rounded border border-gray-200"
        >
          {key}: {String(value)}
        </span>
      ))}
    </div>
  );
}

/**
 * 简单时间线
 * 更紧凑的显示方式
 */
export function SimpleTimeline({
  events,
  maxEvents = 10,
  className,
}: {
  events: TimelineEvent[];
  maxEvents?: number;
  className?: string;
}) {
  const displayEvents = events.slice(-maxEvents);

  return (
    <div className={clsx('space-y-1', className)}>
      {displayEvents.map((event) => {
        const config = getTimelineEventTypeConfig(event.type);
        return (
          <div
            key={event.id}
            className="flex items-center gap-2 text-xs py-1"
          >
            <span className={clsx('w-4 text-center', config.color)}>
              {config.icon}
            </span>
            <span className="text-gray-600 truncate flex-1">
              {event.title}
            </span>
            <span className="text-gray-400 shrink-0">
              {event.formattedTime}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 甘特图样式的节点时间线
 */
export function NodeGanttChart({
  nodes,
  startTime,
  className,
}: {
  nodes: Array<{
    nodeId: string;
    nodeName: string;
    startTime: number;
    endTime?: number;
    status: 'running' | 'completed' | 'failed';
  }>;
  startTime: number;
  className?: string;
}) {
  const endTime = useMemo(() => {
    return Math.max(
      ...nodes.map((n) => n.endTime || Date.now()),
      startTime + 1
    );
  }, [nodes, startTime]);

  const totalDuration = endTime - startTime;

  const getPosition = (nodeStart: number, nodeEnd?: number) => {
    const left = ((nodeStart - startTime) / totalDuration) * 100;
    const width = ((nodeEnd || Date.now()) - nodeStart) / totalDuration * 100;
    return { left, width: Math.max(width, 1) };
  };

  const statusColors = {
    running: 'bg-amber-500',
    completed: 'bg-green-500',
    failed: 'bg-red-500',
  };

  return (
    <div className={clsx('space-y-2', className)}>
      {/* Time axis */}
      <div className="flex items-center text-xs text-gray-400 mb-1">
        <span>{formatTime(startTime)}</span>
        <div className="flex-1 mx-2 border-t border-gray-200" />
        <span>{formatTime(endTime)}</span>
      </div>

      {/* Nodes */}
      <div className="relative">
        {/* Background grid */}
        <div className="absolute inset-0 flex">
          {[0, 25, 50, 75, 100].map((pct) => (
            <div
              key={pct}
              className="flex-1 border-l border-gray-100"
              style={{ width: '25%' }}
            />
          ))}
        </div>

        {/* Node bars */}
        <div className="space-y-1 relative">
          {nodes.map((node) => {
            const { left, width } = getPosition(node.startTime, node.endTime);
            return (
              <div key={node.nodeId} className="h-6 relative">
                {/* Label */}
                <span className="absolute left-0 top-0 text-xs text-gray-600 truncate w-20">
                  {node.nodeName}
                </span>
                {/* Bar */}
                <div
                  className={clsx(
                    'absolute h-4 top-1 rounded-sm',
                    statusColors[node.status]
                  )}
                  style={{
                    left: `calc(5rem + ${left}%)`,
                    width: `${width}%`,
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * 格式化时间
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}
