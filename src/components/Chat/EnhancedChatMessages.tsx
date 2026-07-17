/**
 * 增强版聊天消息列表组件 - 支持内容块架构
 *
 * 核心特性：
 * - Assistant 消息包含 blocks 数组
 * - 工具调用穿插在文本中间显示
 * - 支持流式更新内容块
 *
 * 性能优化：
 * - 流式阶段直接从 currentMessage 读取内容，不更新 messages 数组
 * - 避免段落级缓冲导致的整个消息列表重渲染
 *
 * Props:
 * - sessionId: 可选，指定要显示的会话 ID（用于多窗口场景）
 * - compact: 可选，compact 模式隐藏导航器和搜索面板
 */

import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import type { ChatMessage, AssistantChatMessage, TextBlock, ThinkingBlock } from '@/types';
import { getChatDisplayStyleVars } from '@/types';
import { useConfigStore } from '@/stores';
import { useActiveSessionMessages, useActiveSessionStreaming, useSessionMessages, useSessionStreaming, useActiveSessionActions, useSessionHistoryPaging } from '@/stores/conversationStore/useActiveSession';
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager';
import { useHistoryPrefsStore } from '@/stores/historyPrefsStore';
import {
  findCurrentRoundIndexForRange,
  getRoundScrollTargetIndex,
  groupConversationRounds,
} from '@/utils/conversationRounds';
import { ChatNavigator } from './ChatNavigator';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { useMessageSearch, MessageSearchPanel } from './MessageSearchPanel';
import { VIEWPORT_EXTENSION, FOOTER_SPACER_STYLE } from './chatUtils/constants';
import { renderChatMessage } from './renderChatMessage';
import { EmptyState } from './EmptyState';
import type { MessageScrollActions, MessageActions } from './renderChatMessage';

// Re-export for external consumers
export type { MessageScrollActions, MessageActions } from './renderChatMessage';
export { renderChatMessage } from './renderChatMessage';

/** 组件 Props */
interface EnhancedChatMessagesProps {
  /** 指定会话 ID，不提供时使用活跃会话 */
  sessionId?: string;
  /** 渲染模式：full 完整功能，compact 精简模式（用于多窗口格子） */
  compact?: boolean;
  /** 编辑消息回调（由父组件控制输入框编辑模式） */
  onEditMessage?: (messageId: string, content: string) => void;
}

export function EnhancedChatMessages({ sessionId, compact = false, onEditMessage }: EnhancedChatMessagesProps = {}) {
  const chatDisplay = useConfigStore((state) => state.config?.chatDisplay);
  const chatDisplayStyle = useMemo(() => getChatDisplayStyleVars(chatDisplay), [chatDisplay]);

  // 根据是否提供 sessionId 选择使用对应的 hooks
  const activeSessionData = useActiveSessionMessages();
  const activeIsStreaming = useActiveSessionStreaming();
  const sessionData = useSessionMessages(sessionId ?? null);
  const sessionIsStreaming = useSessionStreaming(sessionId ?? null);

  // 选择数据源
  const { messages, currentMessage } = sessionId ? sessionData : activeSessionData;
  const isStreaming = sessionId ? sessionIsStreaming : activeIsStreaming;

  // 消息操作（编辑/重新生成）
  const { regenerateResponse } = useActiveSessionActions();
  const messageActions = useMemo<MessageActions | undefined>(() => {
    if (!onEditMessage && !regenerateResponse) return undefined;
    return {
      onEdit: onEditMessage,
      onRegenerate: regenerateResponse,
    };
  }, [onEditMessage, regenerateResponse]);

  // 可见范围变更和归档加载路由到正确的 session store
  const onVisibleRangeChange = useCallback((start: number, end: number) => {
    const targetId = sessionId ?? sessionStoreManager.getState().activeSessionId;
    if (!targetId) return;
    const store = sessionStoreManager.getState().stores.get(targetId)?.getState();
    if (!store) return;
    return store.onVisibleRangeChange(start, end);
  }, [sessionId]);

  // ===== 尾部优先恢复：向上补读更早的消息 =====
  const historyPaging = useSessionHistoryPaging(sessionId ?? null);
  const restorePageSize = useHistoryPrefsStore((s) => s.restorePageSize);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /** 请求补读时的 (首条消息 id, 消息数)，用于识别 prepend 并恢复滚动位置 */
  const pendingPrependRef = useRef<{ firstId: string | null; len: number } | null>(null);

  const handleLoadEarlier = useCallback(() => {
    if (loadingEarlier) return;
    const targetId = sessionId ?? sessionStoreManager.getState().activeSessionId;
    if (!targetId) return;
    const store = sessionStoreManager.getState().stores.get(targetId)?.getState();
    if (!store || !store.historyPaging?.hasMore) return;
    setLoadingEarlier(true);
    pendingPrependRef.current = {
      firstId: store.messages[0]?.id ?? null,
      len: store.messages.length,
    };
    store.loadMoreArchivedMessages(restorePageSize);
  }, [sessionId, loadingEarlier, restorePageSize]);

  // prepend 完成后恢复滚动位置（旧首条消息回到视口顶部）
  useEffect(() => {
    const pending = pendingPrependRef.current;
    if (!pending) return;
    const firstId = messages[0]?.id ?? null;
    if (messages.length > pending.len && firstId !== pending.firstId) {
      const added = messages.length - pending.len;
      pendingPrependRef.current = null;
      setLoadingEarlier(false);
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: added, align: 'start' });
      });
    } else if (messages.length <= pending.len && firstId === pending.firstId) {
      // 没有更早消息（hasMore 边界）→ 解除加载态
      const timer = setTimeout(() => {
        if (pendingPrependRef.current === pending) {
          pendingPrependRef.current = null;
          setLoadingEarlier(false);
        }
      }, 1200);
      return () => clearTimeout(timer);
    }
  }, [messages]);

  // 性能优化：流式阶段合并 currentMessage 到消息列表
  const prevDisplayMessagesRef = useRef<ChatMessage[]>([]);
  const lastContentRef = useRef<{ id: string; contentLen: number; blockCount: number } | null>(null);

  const displayMessages = useMemo(() => {
    if (!currentMessage || !isStreaming) {
      prevDisplayMessagesRef.current = messages;
      lastContentRef.current = null;
      return messages;
    }

    const lastBlock = currentMessage.blocks[currentMessage.blocks.length - 1];
    const currentContentLen = lastBlock?.type === 'text'
      ? (lastBlock as TextBlock).content?.length || 0
      : lastBlock?.type === 'thinking'
        ? (lastBlock as ThinkingBlock).content?.length || 0
        : 0;
    const currentBlockCount = currentMessage.blocks.length;

    if (
      lastContentRef.current?.id === currentMessage.id &&
      lastContentRef.current?.contentLen === currentContentLen &&
      lastContentRef.current?.blockCount === currentBlockCount
    ) {
      return prevDisplayMessagesRef.current;
    }

    lastContentRef.current = { id: currentMessage.id, contentLen: currentContentLen, blockCount: currentBlockCount };

    const existingIndex = messages.findIndex(m => m.id === currentMessage.id);

    if (existingIndex >= 0) {
      const updated: ChatMessage[] = [
        ...messages.slice(0, existingIndex),
        {
          ...messages[existingIndex],
          engineId: currentMessage.engineId,
          blocks: currentMessage.blocks,
          isStreaming: true,
        } as AssistantChatMessage,
        ...messages.slice(existingIndex + 1),
      ];
      prevDisplayMessagesRef.current = updated;
      return updated;
    } else {
      const newMessages: ChatMessage[] = [...messages, {
        id: currentMessage.id,
        type: 'assistant' as const,
        engineId: currentMessage.engineId,
        blocks: currentMessage.blocks,
        timestamp: new Date().toISOString(),
        isStreaming: true,
      }];
      prevDisplayMessagesRef.current = newMessages;
      return newMessages;
    }
  }, [messages, currentMessage, isStreaming]);

  const isEmpty = displayMessages.length === 0;

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [currentRoundIndex, setCurrentRoundIndex] = useState(0);

  const conversationRounds = useMemo(() => {
    return groupConversationRounds(displayMessages);
  }, [displayMessages]);

  // 消息搜索功能
  const {
    searchQuery,
    setSearchQuery,
    isSearchVisible,
    openSearch,
    closeSearch,
    currentMatchIndex,
    totalMatches,
    currentMatchMessageId,
    goToPrevious,
    goToNext,
  } = useMessageSearch(displayMessages);

  // 搜索结果跳转
  useEffect(() => {
    if (currentMatchMessageId && virtuosoRef.current) {
      const index = displayMessages.findIndex(m => m.id === currentMatchMessageId);
      if (index >= 0) {
        virtuosoRef.current.scrollToIndex({
          index,
          align: 'center',
          behavior: 'smooth',
        });
      }
    }
  }, [currentMatchMessageId, displayMessages]);

  // 键盘快捷键：Ctrl+F / Cmd+F 打开搜索
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openSearch]);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setAutoScroll(atBottom);
  }, []);

  // 监听可见范围变化
  const handleRangeChange = useCallback((range: { startIndex: number; endIndex: number }) => {
    const { startIndex, endIndex } = range;

    onVisibleRangeChange(startIndex, endIndex);

    const targetRound = findCurrentRoundIndexForRange(conversationRounds, startIndex, endIndex);
    if (targetRound >= 0) {
      setCurrentRoundIndex(targetRound);
    }
  }, [conversationRounds, onVisibleRangeChange]);

  const scrollToRound = useCallback((roundIndex: number) => {
    const round = conversationRounds[roundIndex];
    if (!round || !virtuosoRef.current) return;

    const targetIndex = getRoundScrollTargetIndex(round);
    if (targetIndex === null) return;

    virtuosoRef.current.scrollToIndex({
      index: targetIndex,
      align: 'start',
      behavior: 'smooth',
    });

    setAutoScroll(false);
    setCurrentRoundIndex(roundIndex);
  }, [conversationRounds]);

  const scrollToBottom = useCallback(() => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollTo({
      top: Number.MAX_SAFE_INTEGER,
      behavior: 'smooth',
    });
    setAutoScroll(true);
  }, []);

  const scrollToTop = useCallback(() => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollToIndex({
      index: 0,
      align: 'start',
      behavior: 'smooth',
    });
    setAutoScroll(false);
  }, []);

  const scrollToMessage = useCallback((index: number) => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollToIndex({
      index,
      align: 'start',
      behavior: 'smooth',
    });
    setAutoScroll(false);
  }, []);

  const scrollActions = useMemo<MessageScrollActions>(() => ({
    scrollToMessage,
    scrollToTop,
    scrollToBottom,
  }), [scrollToMessage, scrollToTop, scrollToBottom]);

  // 「加载更早」头部：磁盘上还有未加载的更早消息时出现（尾部优先恢复）
  const hasEarlier = !!historyPaging?.hasMore;
  const LoadEarlierHeader = useMemo(() => {
    if (!hasEarlier) return undefined;
    const Header = () => (
      <div className="flex items-center justify-center py-2">
        <button
          onClick={handleLoadEarlier}
          disabled={loadingEarlier}
          className="px-3 py-1.5 text-xs rounded-full border border-border-subtle bg-background-elevated/70 text-text-secondary hover:text-text-primary hover:border-primary/40 transition-colors disabled:opacity-60"
        >
          {loadingEarlier ? '正在加载更早的消息…' : '加载更早的消息'}
        </button>
      </div>
    );
    return Header;
  }, [hasEarlier, loadingEarlier, handleLoadEarlier]);

  return (
    <div className="chat-display-root flex-1 overflow-hidden flex flex-col" style={chatDisplayStyle}>
      {/* 消息列表 */}
      <div className="flex-1 min-h-0 relative">
        <div className="h-full">
          {isEmpty ? (
            <EmptyState />
          ) : (
            <Virtuoso
              ref={virtuosoRef}
              style={{ height: '100%' }}
              data={displayMessages}
              itemContent={(index, item) => {
                return renderChatMessage(item, index, scrollActions, messageActions);
              }}
              components={{
                EmptyPlaceholder: () => null,
                Footer: () => <div style={FOOTER_SPACER_STYLE} />,
                ...(LoadEarlierHeader ? { Header: LoadEarlierHeader } : {}),
              }}
              followOutput={autoScroll ? (isStreaming ? true : 'smooth') : false}
              atBottomStateChange={handleAtBottomStateChange}
              atBottomThreshold={150}
              rangeChanged={handleRangeChange}
              startReached={hasEarlier ? handleLoadEarlier : undefined}
              increaseViewportBy={VIEWPORT_EXTENSION}
              initialTopMostItemIndex={displayMessages.length - 1}
            />
          )}
        </div>

        {/* 消息搜索面板 - compact 模式下隐藏 */}
        {!compact && isSearchVisible && (
          <MessageSearchPanel
            visible={isSearchVisible}
            onClose={closeSearch}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            currentMatchIndex={currentMatchIndex}
            totalMatches={totalMatches}
            onPrevious={goToPrevious}
            onNext={goToNext}
          />
        )}

        {/* 聊天导航器 - compact 模式下隐藏 */}
        {!compact && !isEmpty && (
          <ChatNavigator
            rounds={conversationRounds}
            currentRoundIndex={currentRoundIndex}
            onScrollToBottom={scrollToBottom}
            onScrollToRound={scrollToRound}
          />
        )}

        {/* 回到底部悬浮按钮 - 离开底部时显示，流式时提示有新内容 */}
        {!isEmpty && !autoScroll && (
          <ScrollToBottomButton
            onClick={scrollToBottom}
            showNewIndicator={isStreaming}
          />
        )}
      </div>
    </div>
  );
}
