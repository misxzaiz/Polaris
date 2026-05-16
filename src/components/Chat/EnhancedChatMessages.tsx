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
import { ChevronDown } from 'lucide-react';
import type { ChatMessage, AssistantChatMessage, TextBlock } from '../../types';
import { useActiveSessionMessages, useActiveSessionStreaming, useSessionMessages, useSessionStreaming } from '../../stores/conversationStore/useActiveSession';
import { sessionStoreManager } from '../../stores/conversationStore/sessionStoreManager';
import {
  findCurrentRoundIndexForRange,
  getRoundScrollTargetIndex,
  groupConversationRounds,
} from '../../utils/conversationRounds';
import { ChatNavigator } from './ChatNavigator';
import { useMessageSearch, MessageSearchPanel } from './MessageSearchPanel';
import { VIEWPORT_EXTENSION, FOOTER_SPACER_STYLE } from './chatUtils/constants';
import { renderChatMessage } from './renderChatMessage';
import { EmptyState } from './EmptyState';
import type { MessageScrollActions } from './renderChatMessage';

// Re-export for external consumers
export type { MessageScrollActions } from './renderChatMessage';
export { renderChatMessage } from './renderChatMessage';

/** 组件 Props */
interface EnhancedChatMessagesProps {
  /** 指定会话 ID，不提供时使用活跃会话 */
  sessionId?: string;
  /** 渲染模式：full 完整功能，compact 精简模式（用于多窗口格子） */
  compact?: boolean;
}

export function EnhancedChatMessages({ sessionId, compact = false }: EnhancedChatMessagesProps = {}) {
  // 根据是否提供 sessionId 选择使用对应的 hooks
  const activeSessionData = useActiveSessionMessages();
  const activeIsStreaming = useActiveSessionStreaming();
  const sessionData = useSessionMessages(sessionId ?? null);
  const sessionIsStreaming = useSessionStreaming(sessionId ?? null);

  // 选择数据源
  const { messages, archivedMessages, currentMessage } = sessionId ? sessionData : activeSessionData;
  const isStreaming = sessionId ? sessionIsStreaming : activeIsStreaming;

  // 可见范围变更和归档加载路由到正确的 session store
  const onVisibleRangeChange = useCallback((start: number, end: number) => {
    const targetId = sessionId ?? sessionStoreManager.getState().activeSessionId;
    if (!targetId) return;
    const store = sessionStoreManager.getState().stores.get(targetId)?.getState();
    if (!store) return;
    return store.onVisibleRangeChange(start, end);
  }, [sessionId]);

  const loadMoreArchivedMessages = useCallback((count = 20) => {
    const targetId = sessionId ?? sessionStoreManager.getState().activeSessionId;
    if (!targetId) return;
    const store = sessionStoreManager.getState().stores.get(targetId)?.getState();
    if (!store) return;
    return store.loadMoreArchivedMessages(count);
  }, [sessionId]);

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
    const currentContentLen = lastBlock?.type === 'text' ? (lastBlock as TextBlock).content?.length || 0 : 0;
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
        blocks: currentMessage.blocks,
        timestamp: new Date().toISOString(),
        isStreaming: true,
      }];
      prevDisplayMessagesRef.current = newMessages;
      return newMessages;
    }
  }, [messages, currentMessage, isStreaming]);

  const isEmpty = displayMessages.length === 0;
  const hasArchive = archivedMessages.length > 0;

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

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* 归档消息提示 - 分批加载 */}
      {hasArchive && (
        <div className="flex justify-center py-2 bg-background-surface border-b border-border">
          <button
            onClick={() => loadMoreArchivedMessages(20)}
            className="text-xs text-primary hover:text-primary-hover transition-colors flex items-center gap-2 px-3 py-1.5 rounded-full hover:bg-primary-faint"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
            加载更早的消息 ({archivedMessages.length} 条)
          </button>
        </div>
      )}

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
                return renderChatMessage(item, index, scrollActions);
              }}
              components={{
                EmptyPlaceholder: () => null,
                Header: hasArchive ? (() => (
                  <div className="flex justify-center py-3">
                    <button
                      onClick={() => loadMoreArchivedMessages(20)}
                      className="text-xs text-text-tertiary hover:text-primary transition-colors flex items-center gap-1"
                    >
                      <ChevronDown className="w-3 h-3" />
                      加载更早 20 条消息
                    </button>
                  </div>
                )) : undefined,
                Footer: () => <div style={FOOTER_SPACER_STYLE} />,
              }}
              followOutput={autoScroll ? (isStreaming ? true : 'smooth') : false}
              atBottomStateChange={handleAtBottomStateChange}
              atBottomThreshold={150}
              rangeChanged={handleRangeChange}
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
      </div>
    </div>
  );
}
