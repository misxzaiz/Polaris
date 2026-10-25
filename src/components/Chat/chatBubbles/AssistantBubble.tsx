/**
 * 助手消息气泡组件 - 使用内容块架构
 */

import { memo, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssistantChatMessage, TextBlock, ThinkingBlock } from '@/types';
import { formatContent, extractAssistantText } from '../chatUtils/helpers';
import { renderBlocksWithGrouping } from '../tool-calls/blockGrouping';
import { MessageContextMenu } from './MessageContextMenu';
import { Bot, RefreshCw, Copy, Check } from 'lucide-react';
import { getEngineDisplayName } from '@/utils/engineDisplay';
import { MarkdownImageSurface } from '../common/MarkdownImageSurface';
import { useThemeStore } from '@/stores/themeStore';
import { useToastStore } from '@/stores/toastStore';
import { useLongPress } from './useLongPress';

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
  // 读取当前主题的沉浸头像 URL
  const immersiveAvatarUrl = useThemeStore(s => s.activeTheme?.immersive?.enabled ? s.activeTheme.immersive.avatar?.url : null);
  const avatarUrl = immersiveAvatarUrl;

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
    } catch (e) {
      // 此前静默吞错，用户以为复制成功（审计 5.11）
      useToastStore.getState().error(
        t('contextMenu.copyFailed', '复制失败'),
        e instanceof Error ? e.message : String(e)
      );
    }
  }, [messageText, t]);

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

  // 批 6（审计 5.8）：触屏长按弹出消息菜单（同 UserBubble，共用手势 hook）
  const openMenuAt = useCallback((x: number, y: number) => {
    setContextMenu({ visible: true, x, y });
  }, []);
  const { touchHandlers: longPressHandlers } = useLongPress(openMenuAt);

  return (
    <>
      <div className="chat-assistant-message flex gap-2 p-2 rounded-lg group" onContextMenu={handleContextMenu} {...longPressHandlers}>
        {/* Avatar */}
        <div className="shrink-0 mt-0.5">
          <div className="w-5 h-5 rounded-full bg-primary-faint flex items-center justify-center overflow-hidden">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <Bot className="w-3.5 h-3.5 text-primary" />
            )}
          </div>
        </div>

        {/* 内容 */}
        <div className="chat-assistant-content flex-1 min-w-0">
          {/* 头部信息 + hover 操作 */}
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-text-primary">{getEngineDisplayName(message.engineId)}</span>
            <span className="text-xs text-text-tertiary">
              {new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
            {/* Hover 操作栏：复制 + 重新生成（与用户消息「复制 + 编辑」对称） */}
            {(messageText || (!message.isStreaming && onRegenerate)) && (
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
                {!message.isStreaming && onRegenerate && (
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

          {/* 渲染内容块（过程块相邻成组折叠，仅非空文本/面板类块打断分组） */}
          {hasBlocks ? (
            <div>
              {renderBlocksWithGrouping(message.blocks, message.isStreaming)}
            </div>
          ) : message.content ? (
            // 兼容旧格式（content 字符串）
            <MarkdownImageSurface>
              <div
                className="chat-prose prose prose-invert max-w-none"
                dangerouslySetInnerHTML={{ __html: formatContent(message.content) }}
              />
            </MarkdownImageSurface>
          ) : null}

          {/* 中断残留提示：历史恢复时若末条回复是未完成的 checkpoint 快照，
              展示「回复中断（部分内容）」的说明条，明确这不是完整回复 */}
          {message.interrupted && (
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-text-tertiary rounded-md bg-background-hover px-2 py-1 w-fit">
              <span aria-hidden>⚠️</span>
              <span>{t('message.interrupted')}</span>
            </div>
          )}

          {/* 流式光标 —— 已移到 ProgressiveStreamingMarkdown 里"最后一段"的字符末尾。
              气泡层不再显示，避免与字符末尾 caret 重复。 */}
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
          message={message}
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

  if (nextProps.message.isStreaming) {
    // 流式消息：保留精细比较（避免每次 token 追加都整条重渲染）。
    // 引用变化时仍需检查最后一个文本/思考块是否真正增长。
    if (prevBlocks === nextBlocks) return true;

    const lastPrev = prevBlocks[prevBlocks.length - 1];
    const lastNext = nextBlocks[nextBlocks.length - 1];

    if (lastPrev.type === 'text' && lastNext.type === 'text') {
      if ((lastPrev as TextBlock).content.length !== (lastNext as TextBlock).content.length) return false;
    } else if (lastPrev.type === 'thinking' && lastNext.type === 'thinking') {
      if ((lastPrev as ThinkingBlock).content.length !== (lastNext as ThinkingBlock).content.length) return false;
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
      // 思考块折叠状态变化（完成自动折叠）必须放行重渲染
      if (pb.type === 'thinking' && nb.type === 'thinking') {
        if (pb.collapsed !== nb.collapsed) return false;
      }
      // 交互块（question/form/plugin_card/plan_mode）：内部 status/answers 异步回填，
      // 引用变化但类型不变时若 status 变化必须放行重渲染（否则提交答案后卡片停在未答态）。
      if (pb.type === 'question' && nb.type === 'question') {
        if (pb.status !== nb.status) return false;
        if (pb.declined !== nb.declined) return false;
        if (JSON.stringify(pb.answers) !== JSON.stringify(nb.answers)) return false;
      }
      if (pb.type === 'form' && nb.type === 'form') {
        if (pb.status !== nb.status) return false;
        if (pb.ok !== nb.ok) return false;
      }
      if (pb.type === 'plugin_card' && nb.type === 'plugin_card') {
        if (pb.status !== nb.status) return false;
      }
      if (pb.type === 'plan_mode' && nb.type === 'plan_mode') {
        if (pb.status !== nb.status) return false;
      }
    }

    return true;
  }

  // 非流式消息：blocks 引用变化即视为内容已更新
  // （form / plugin_card 等异步回填块会在非流式消息上更新 status/ok/receipt，
  //  必须放行重渲染；引用相同才算无变化）。
  return prevBlocks === nextBlocks;
});
