/**
 * 聊天状态栏组件
 *
 * 显示当前对话的统计信息：
 * - 消息数量
 * - 工具调用次数
 * - 会话时长
 */

import { useMemo } from 'react';
import { useEventChatStore } from '../../stores';
import { MessageSquare, Wrench, Clock } from 'lucide-react';
import { clsx } from 'clsx';

interface ChatStatusBarProps {
  /** 是否紧凑模式 */
  compact?: boolean;
}

/**
 * 计算会话时长
 */
function formatDuration(startTime: string | null): string {
  if (!startTime) return '0分钟';

  const start = new Date(startTime).getTime();
  const now = Date.now();
  const diffMs = now - start;

  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours > 0) {
    return `${hours}小时${remainingMinutes}分钟`;
  }
  return `${minutes}分钟`;
}

/**
 * 聊天状态栏组件
 */
export function ChatStatusBar({ compact = false }: ChatStatusBarProps) {
  const messages = useEventChatStore(state => state.messages);
  const currentMessage = useEventChatStore(state => state.currentMessage);
  const isStreaming = useEventChatStore(state => state.isStreaming);

  // 计算统计数据
  const stats = useMemo(() => {
    // 消息数量（用户消息 + 助手消息）
    const userMessages = messages.filter(m => m.type === 'user').length;
    const assistantMessages = messages.filter(m => m.type === 'assistant').length;
    const totalMessages = userMessages + assistantMessages;

    // 如果有正在流式输出的消息，加 1
    const displayMessages = isStreaming && currentMessage ? totalMessages + 1 : totalMessages;

    // 工具调用次数
    let toolCalls = 0;
    for (const message of messages) {
      if (message.type === 'assistant' && message.blocks) {
        toolCalls += message.blocks.filter(b => b.type === 'tool_call' || b.type === 'tool_group').length;
      }
    }
    // 加上当前流式消息中的工具调用
    if (currentMessage?.blocks) {
      toolCalls += currentMessage.blocks.filter(b => b.type === 'tool_call' || b.type === 'tool_group').length;
    }

    // 会话开始时间（第一条消息的时间）
    const firstMessage = messages[0];
    const startTime = firstMessage?.timestamp || null;

    return {
      userMessages,
      assistantMessages,
      totalMessages: displayMessages,
      toolCalls,
      startTime,
    };
  }, [messages, currentMessage, isStreaming]);

  // 无消息时不显示
  if (stats.totalMessages === 0) {
    return null;
  }

  const duration = formatDuration(stats.startTime);

  if (compact) {
    // 紧凑模式：只显示数字
    return (
      <div className="flex items-center gap-3 text-xs text-text-tertiary">
        <span className="flex items-center gap-1">
          <MessageSquare className="w-3 h-3" />
          {stats.totalMessages}
        </span>
        {stats.toolCalls > 0 && (
          <span className="flex items-center gap-1">
            <Wrench className="w-3 h-3" />
            {stats.toolCalls}
          </span>
        )}
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {duration}
        </span>
      </div>
    );
  }

  return (
    <div className={clsx(
      'flex items-center gap-4 px-4 py-1.5 text-xs text-text-tertiary',
      'bg-background-surface/50 border-t border-border-subtle'
    )}>
      {/* 消息统计 */}
      <div className="flex items-center gap-1.5">
        <MessageSquare className="w-3.5 h-3.5 text-text-muted" />
        <span>
          <span className="text-text-secondary">{stats.userMessages}</span>
          <span className="mx-0.5">/</span>
          <span className="text-primary">{stats.assistantMessages}</span>
          <span className="ml-1 text-text-tertiary">对话</span>
        </span>
      </div>

      {/* 工具调用 */}
      {stats.toolCalls > 0 && (
        <div className="flex items-center gap-1.5">
          <Wrench className="w-3.5 h-3.5 text-warning" />
          <span>
            <span className="text-text-secondary">{stats.toolCalls}</span>
            <span className="ml-1 text-text-tertiary">工具</span>
          </span>
        </div>
      )}

      {/* 会话时长 */}
      <div className="flex items-center gap-1.5">
        <Clock className="w-3.5 h-3.5 text-text-muted" />
        <span>{duration}</span>
      </div>

      {/* 流式状态指示 */}
      {isStreaming && (
        <div className="flex items-center gap-1.5 ml-auto">
          <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
          <span className="text-primary">响应中...</span>
        </div>
      )}
    </div>
  );
}
