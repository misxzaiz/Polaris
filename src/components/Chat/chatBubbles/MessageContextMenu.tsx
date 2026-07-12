/**
 * 消息右键上下文菜单
 */

import { memo, useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ttsService } from '@/services/ttsService';
import { extractReadableText } from '../chatUtils/helpers';
import { Check, Copy, ArrowUp, ChevronsUp, ChevronsDown, Volume2, Square, Loader2 } from 'lucide-react';
import type { AssistantChatMessage, UserChatMessage } from '@/types';

export const MessageContextMenu = memo(function MessageContextMenu({
  visible,
  x,
  y,
  messageIndex,
  messageText,
  message,
  onScrollToMessage,
  onScrollToTop,
  onScrollToBottom,
  onClose,
}: {
  visible: boolean;
  x: number;
  y: number;
  messageIndex?: number;
  messageText?: string;
  message?: AssistantChatMessage | UserChatMessage;
  onScrollToMessage?: (index: number) => void;
  onScrollToTop?: () => void;
  onScrollToBottom?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('chat');
  const menuRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef({ x, y });
  const [copied, setCopied] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // 更新位置引用
  useEffect(() => {
    positionRef.current = { x, y };
  }, [x, y]);

  // 调整菜单位置，避免超出视口
  useEffect(() => {
    if (!visible || !menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let adjustedX = positionRef.current.x;
    let adjustedY = positionRef.current.y;

    // 右边界检测
    if (adjustedX + rect.width > viewportWidth) {
      adjustedX = viewportWidth - rect.width - 8;
    }

    // 下边界检测
    if (adjustedY + rect.height > viewportHeight) {
      adjustedY = viewportHeight - rect.height - 8;
    }

    // 应用调整后的位置
    if (adjustedX !== positionRef.current.x || adjustedY !== positionRef.current.y) {
      menu.style.left = `${adjustedX}px`;
      menu.style.top = `${adjustedY}px`;
    }
  }, [visible]);

  // 点击外部或 ESC 关闭菜单
  useEffect(() => {
    if (!visible) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    // 延迟添加监听器，避免立即关闭
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible, onClose]);

  // 跳转到消息位置
  const handleScrollToMessage = useCallback(() => {
    if (onScrollToMessage && messageIndex !== undefined) {
      onScrollToMessage(messageIndex);
      onClose();
    }
  }, [onScrollToMessage, messageIndex, onClose])

  const handleScrollToTop = useCallback(() => {
    onScrollToTop?.();
    onClose();
  }, [onScrollToTop, onClose])

  const handleScrollToBottom = useCallback(() => {
    onScrollToBottom?.();
    onClose();
  }, [onScrollToBottom, onClose])

  // 复制消息内容
  const handleCopy = useCallback(async () => {
    if (!messageText) return;
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
      setTimeout(() => { setCopied(false); onClose(); }, 600);
    } catch {
      onClose();
    }
  }, [messageText, onClose]);

  // TTS 状态同步：菜单显示时注册回调，隐藏时清理
  useEffect(() => {
    if (!visible) return;

    const setStatus = (status: string) => setIsSpeaking(status === 'playing' || status === 'synthesizing');
    ttsService.setCallbacks({ onStatusChange: setStatus });
    setIsSpeaking(ttsService.isPlaying());

    return () => {
      ttsService.setCallbacks({});
    };
  }, [visible]);

  // 朗读消息（使用 stripMarkdown 后的纯文本，避免读到 markdown 源码）
  const handleSpeak = useCallback(async () => {
    const readable = message ? extractReadableText(message) : '';
    if (!readable) return;
    if (ttsService.isPlaying()) {
      ttsService.stop();
      return;
    }
    await ttsService.speak(readable, { force: true });
  }, [message]);

  if (!visible) return null;

  const hasJumpActions = messageIndex !== undefined && onScrollToMessage;
  const hasScrollActions = onScrollToTop || onScrollToBottom;
  const hasCopyAction = !!messageText;

  return (
    <div
      ref={menuRef}
      className="fixed z-[10000] bg-background-surface border border-border rounded-lg shadow-lg py-1 min-w-[180px]"
      style={{ left: x, top: y }}
    >
      {/* 跳转到消息开头 */}
      {hasJumpActions && (
        <button
          type="button"
          className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-background-hover hover:text-text-primary flex items-center gap-2 transition-colors"
          onClick={handleScrollToMessage}
        >
          <ArrowUp size={14} />
          <span>{t('contextMenu.scrollToStart')}</span>
        </button>
      )}

      {/* 跳转到顶部 */}
      {onScrollToTop && (
        <button
          type="button"
          className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-background-hover hover:text-text-primary flex items-center gap-2 transition-colors"
          onClick={handleScrollToTop}
        >
          <ChevronsUp size={14} />
          <span>{t('contextMenu.scrollToTop')}</span>
        </button>
      )}

      {/* 跳转到底部 */}
      {onScrollToBottom && (
        <button
          type="button"
          className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-background-hover hover:text-text-primary flex items-center gap-2 transition-colors"
          onClick={handleScrollToBottom}
        >
          <ChevronsDown size={14} />
          <span>{t('contextMenu.scrollToBottom')}</span>
        </button>
      )}

      {/* 分割线 */}
      {(hasJumpActions || hasScrollActions) && hasCopyAction && (
        <div className="border-t border-border my-1" />
      )}

      {/* 复制消息内容 */}
      {hasCopyAction && (
        <button
          type="button"
          className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-background-hover hover:text-text-primary flex items-center gap-2 transition-colors"
          onClick={handleCopy}
        >
          {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
          <span>{copied ? t('contextMenu.copied') : t('contextMenu.copyMessage')}</span>
        </button>
      )}

      {/* 朗读消息 */}
      {hasCopyAction && (
        <button
          type="button"
          className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-background-hover hover:text-text-primary flex items-center gap-2 transition-colors"
          onClick={handleSpeak}
        >
          {ttsService.getStatus() === 'synthesizing' && <Loader2 size={14} className="animate-spin text-warning" />}
          {isSpeaking && ttsService.isPlaying() ? (
            <Square size={14} className="text-primary" />
          ) : (
            <Volume2 size={14} />
          )}
          <span>
            {isSpeaking && ttsService.isPlaying()
              ? t('contextMenu.stopSpeaking')
              : t('contextMenu.speak')}
          </span>
        </button>
      )}
    </div>
  );
});
