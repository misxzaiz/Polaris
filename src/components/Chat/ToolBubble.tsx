/**
 * ToolBubble - 单个工具调用消息组件
 *
 * 作为独立消息展示在对话流中，支持折叠/展开
 */

import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ToolChatMessage } from '@/types';
import { formatDuration } from '@/utils/toolSummary';
import { getToolStatusIcon, getToolStatusColor } from '@/utils/toolStatusHelpers';
import { copyToClipboard } from '@/utils/clipboard';
import { IconChevronRight, IconCopy } from '../Common/Icons';
import { clsx } from 'clsx';

interface ToolBubbleProps {
  message: ToolChatMessage;
}

/** 格式化输入输出显示 */
function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const ToolBubble = memo(function ToolBubble({ message }: ToolBubbleProps) {
  const { t } = useTranslation('chat');
  const [isExpanded, setIsExpanded] = useState(false);
  const StatusIcon = getToolStatusIcon(message.status);

  // 计算时长
  const duration = message.duration ||
    (message.completedAt ? formatDuration(
      new Date(message.completedAt).getTime() - new Date(message.startedAt).getTime()
    ) : undefined);

  return (
    <div className="my-2">
      {/* 工具消息主体 */}
      <div
        className={clsx(
          "group flex items-start gap-2 px-3 py-2 rounded-lg border transition-all",
          message.status === 'running' && "bg-warning-faint border-warning/30",
          message.status === 'completed' && "bg-success-faint border-success/30",
          message.status === 'failed' && "bg-error-faint border-error/30",
          message.status === 'pending' && "bg-background-surface border-border",
        )}
      >
        {/* 状态图标 */}
        {StatusIcon && (
          <div className={clsx("shrink-0 mt-0.5", getToolStatusColor(message.status))}>
            <StatusIcon size={14} />
          </div>
        )}

        {/* 摘要内容 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={clsx(
              "text-sm",
              message.status === 'running' ? "text-text-primary" : "text-text-secondary"
            )}>
              {message.summary}
            </span>
            {duration && (
              <span className="text-xs text-text-tertiary">
                {duration}
              </span>
            )}
          </div>

          {/* 错误信息 */}
          {message.status === 'failed' && message.error && (
            <div className="mt-1 text-xs text-error">
              {message.error}
            </div>
          )}
        </div>

        {/* 展开/折叠按钮 */}
        {(message.input || message.output) && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="shrink-0 p-1 text-text-subtle hover:text-text transition-colors rounded hover:bg-background-hover"
            title={isExpanded ? t('toolBubble.collapseDetails') : t('toolBubble.expandDetails')}
          >
            <IconChevronRight
              size={14}
              className={clsx(
                "transition-transform",
                isExpanded && "rotate-90"
              )}
            />
          </button>
        )}
      </div>

      {/* 展开详情 */}
      {isExpanded && (message.input || message.output) && (
        <div className="mt-2 ml-8 space-y-2">
          {/* 输入参数 */}
          {message.input && Object.keys(message.input).length > 0 && (
            <div className="bg-background-secondary rounded-lg border border-border-subtle overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle bg-background-tertiary">
                <span className="text-xs text-text-subtle">{t('toolBubble.inputParams')}</span>
                <button
                  onClick={() => copyToClipboard(formatValue(message.input))}
                  className="flex items-center gap-1 text-xs text-text-muted hover:text-text transition-colors"
                >
                  <IconCopy size={12} />
                  {t('toolBubble.copy')}
                </button>
              </div>
              <pre className="p-3 text-xs text-text-muted overflow-x-auto max-h-32 overflow-y-auto">
                {formatValue(message.input)}
              </pre>
            </div>
          )}

          {/* 输出结果 */}
          {message.status === 'completed' && !message.output && (
            <div className="bg-success-faint border border-success/30 rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-success/20 bg-success/10">
                <span className="text-xs text-text-subtle">{t('toolBubble.outputResult')}</span>
              </div>
              <div className="p-3 text-xs text-success flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span>{t('toolBubble.noOutput')}</span>
              </div>
            </div>
          )}

          {message.output && (
            <div className={clsx(
              "rounded-lg border overflow-hidden",
              message.status === 'failed'
                ? "bg-error-faint border-error/30"
                : "bg-background-secondary border-border-subtle"
            )}>
              <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle bg-background-tertiary">
                <span className="text-xs text-text-subtle">{t('toolBubble.outputResult')}</span>
                <button
                  onClick={() => copyToClipboard(message.output || '')}
                  className="flex items-center gap-1 text-xs text-text-muted hover:text-text transition-colors"
                >
                  <IconCopy size={12} />
                  {t('toolBubble.copy')}
                </button>
              </div>
              <pre className={clsx(
                "p-3 text-xs overflow-x-auto max-h-48 overflow-y-auto",
                message.status === 'failed' ? "text-error" : "text-text-muted"
              )}>
                {message.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
