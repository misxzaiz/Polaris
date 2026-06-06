/**
 * 助手消息气泡组件 - 使用内容块架构
 */

import { memo, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssistantChatMessage, TextBlock } from '@/types';
import { formatContent, extractAssistantText } from '../chatUtils/helpers';
import { renderBlocksWithGrouping } from '../blockGrouping';
import { MessageContextMenu } from './MessageContextMenu';
import { Bot, RefreshCw, Copy, Check } from 'lucide-react';
import { getEngineDisplayName } from '@/utils/engineDisplay';
import { MarkdownImageSurface } from '../MarkdownImageSurface';

export const AssistantBubble = memo(function AssistantBubble({
  message,
  messageIndex,
  onScrollToMessage,
  onScrollToTop,
  onScrollToBottom,
  onRegenerate,
}: {
  message: AssistantChatMessage;
  messageIndex?: number;
  onScrollToMessage?: (index: number) => void;
  onScrollToTop?: () => void;
  onScrollToBottom?: () => void;
  onRegenerate?: (messageId: string) => void;
}) {
  const { t } = useTranslation('chat');
  const hasBlocks = message.blocks && message.blocks.length > 0;

  // 提取消息文本（用于复制）
  const messageText = useMemo(() => extractAssistantText(message), [message]);

  // 重新生成
  const handleRegenerate = useCallback(() => {
    onRegenerate?.(message.id);
  }, [onRegenerate, message.id]);

  // 复制反馈状态
  const [copied, setCopied] = useState(false);

  // 复制助手回答正文（纯文本）
  const handleCopy = useCallback(async () => {
    if (!messageText) return;
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 复制失败静默处理 */ }
  }, [messageText]);

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
  } | null>(null);

  // 右键事件处理
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const selectedText = window.getSelection()?.toString().trim();

    if (selectedText && selectedText.length > 0) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
    });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  return (
    <>
      <div className="flex gap-2 my-2 group" onContextMenu={handleContextMenu}>
        {/* Avatar */}
        <div className="shrink-0 mt-0.5">
          <div className="w-5 h-5 rounded-full bg-primary-faint flex items-center justify-center">
            <Bot className="w-3.5 h-3.5 text-primary" />
          </div>
        </div>

        {/* 内容 */}
        <div className="flex-1 space-y-1 min-w-0">
          {/* 头部信息 + hover 操作 */}
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-text-primary">{getEngineDisplayName(message.engineId)}</span>
            <span className="text-xs text-text-tertiary">
              {new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
            {/* Hover 操作栏：复制 + 重新生成（与用户消息「复制 + 编辑」对称） */}
            {!message.isStreaming && (messageText || onRegenerate) && (
              <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                {messageText && (
                  <button
                    onClick={handleCopy}
                    className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
                    title={copied ? t('contextMenu.copied') : t('contextMenu.copyMessage')}
                  >
                    {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                  </button>
                )}
                {onRegenerate && (
                  <button
                    onClick={handleRegenerate}
                    className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
                    title={t('contextMenu.regenerate')}
                  >
                    <RefreshCw size={14} />
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 渲染内容块（支持工具和思考块折叠聚合） */}
          {hasBlocks ? (
            <div>
              {renderBlocksWithGrouping(message.blocks, message.isStreaming)}
            </div>
          ) : message.content ? (
            // 兼容旧格式（content 字符串）
            <MarkdownImageSurface>
              <div
                className="prose prose-invert prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: formatContent(message.content) }}
              />
            </MarkdownImageSurface>
          ) : null}

          {/* 流式光标 */}
          {message.isStreaming && (
            <span className="inline-flex ml-1">
              <span className="flex gap-0.5 items-end h-4">
                <span className="w-1 h-1 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-1 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            </span>
          )}
        </div>
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <MessageContextMenu
          visible={contextMenu.visible}
          x={contextMenu.x}
          y={contextMenu.y}
          messageIndex={messageIndex}
          messageText={messageText}
          onScrollToMessage={onScrollToMessage}
          onScrollToTop={onScrollToTop}
          onScrollToBottom={onScrollToBottom}
          onClose={handleCloseContextMenu}
        />
      )}
    </>
  );
}, (prevProps, nextProps) => {
  // 优化重渲染：使用浅比较代替深度序列化
  const prevBlocks = prevProps.message.blocks;
  const nextBlocks = nextProps.message.blocks;

  // 基础属性比较
  if (prevProps.message.id !== nextProps.message.id) return false;
  if (prevProps.message.isStreaming !== nextProps.message.isStreaming) return false;
  if (prevProps.messageIndex !== nextProps.messageIndex) return false;

  // blocks 数量不同，需要更新
  if (prevBlocks.length !== nextBlocks.length) return false;

  // 对于流式消息，检查最后一个文本块的内容长度
  if (nextProps.message.isStreaming && prevBlocks.length > 0) {
    const lastPrev = prevBlocks[prevBlocks.length - 1];
    const lastNext = nextBlocks[nextBlocks.length - 1];

    if (lastPrev.type === 'text' && lastNext.type === 'text') {
      if ((lastPrev as TextBlock).content.length !== (lastNext as TextBlock).content.length) return false;
    } else if (lastPrev.type !== lastNext.type) {
      return false;
    }

    // 检查工具调用块的状态变化
    for (let i = 0; i < prevBlocks.length; i++) {
      const pb = prevBlocks[i];
      const nb = nextBlocks[i];
      if (pb.type !== nb.type) return false;
      if (pb.type === 'tool_call' && nb.type === 'tool_call') {
        if (pb.status !== nb.status) return false;
        if (pb.output !== nb.output) return false;
      }
    }
  }

  // 非流式消息，认为没有变化
  return true;
});
