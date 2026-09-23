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

import { forwardRef, useMemo, useState, useRef, useEffect, useCallback } from 'react';
import type { ComponentProps, MutableRefObject } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import type { ChatMessage, AssistantChatMessage, TextBlock, ThinkingBlock } from '@/types';
import { getChatDisplayStyleVars } from '@/types';
import { useConfigStore } from '@/stores';
import { useActiveSessionMessages, useActiveSessionStreaming, useSessionMessages, useSessionStreaming, useActiveSessionActions, useSessionHistoryPaging, useSessionVisibleRange } from '@/stores/conversationStore/useActiveSession';
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager';
import { useHistoryPrefsStore } from '@/stores/historyPrefsStore';
import {
  findCurrentRoundIndexForRange,
  getRoundScrollTargetIndex,
  groupConversationRounds,
} from '@/utils/conversationRounds';
import { ChatNavigator } from '../session/ChatNavigator';
import { ScrollToBottomButton } from '../common/ScrollToBottomButton';
import { useMessageSearch, MessageSearchPanel } from '../search/MessageSearchPanel';
import { VIEWPORT_EXTENSION, FOOTER_SPACER_STYLE } from '../chatUtils/constants';
import { renderChatMessage } from './renderChatMessage';
import { useMessageAutoScroll, AUTO_SCROLL_THRESHOLD } from './useMessageAutoScroll';
import { EmptyState } from '../common/EmptyState';
import { ThinkingOrb } from '../common/ThinkingOrb';
import { DynamicIsland } from '../dynamic-island';
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
  const collapseMode = chatDisplay?.processBlockCollapse ?? 'auto';

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

  // PENDING 状态：已发送消息、正在等待首 token
  const isPending = isStreaming && !currentMessage;

  // 性能优化：流式阶段合并 currentMessage 到消息列表
  const prevDisplayMessagesRef = useRef<ChatMessage[]>([]);
  const lastContentRef = useRef<{ id: string; contentLen: number; blockCount: number; interactiveSig: string } | null>(null);

  /** 交互块状态指纹：question/form 等异步回填块在流式期间内部 status/answers 会变化，
   *  而这些变化不反映在 contentLen/blockCount 上，必须纳入短路检测，否则提交答案后
   *  卡片要等 AI 继续输出（或 session_end）才切到已答态。 */
  const computeInteractiveSig = useCallback((blocks: import('@/types').ContentBlock[]): string => {
    let sig = '';
    for (const b of blocks) {
      if (b.type === 'question') {
        sig += `${b.id}:q${(b as import('@/types').QuestionBlock).status};`;
      } else if (b.type === 'form') {
        sig += `${b.id}:f${(b as import('@/types').FormBlock).status};`;
      } else if (b.type === 'plugin_card') {
        sig += `${b.id}:p${(b as import('@/types').PluginCardBlock).status};`;
      } else if (b.type === 'tool_call') {
        sig += `${b.id}:t${(b as import('@/types').ToolCallBlock).status};`;
      } else if (b.type === 'plan_mode') {
        sig += `${b.id}:m${(b as import('@/types').PlanModeBlock).status};`;
      }
    }
    return sig;
  }, []);

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
    const interactiveSig = computeInteractiveSig(currentMessage.blocks);

    if (
      lastContentRef.current?.id === currentMessage.id &&
      lastContentRef.current?.contentLen === currentContentLen &&
      lastContentRef.current?.blockCount === currentBlockCount &&
      lastContentRef.current?.interactiveSig === interactiveSig
    ) {
      return prevDisplayMessagesRef.current;
    }

    lastContentRef.current = { id: currentMessage.id, contentLen: currentContentLen, blockCount: currentBlockCount, interactiveSig };

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

  // ===== 滚动位置恢复锚点 =====
  // visibleRange 由 onVisibleRangeChange 持续写入 session store（store 级，跨组件生命周期）。
  // 组件因面板切换/resize 重建时，useState(true) 的 autoScroll 会重置 → Virtuoso 用
  // initialTopMostItemIndex 强制锚末尾 → 用户停在中间的位置丢失。这里读取上次 visibleRange：
  //  - null（会话刚从磁盘恢复 / 新会话）→ 锚末尾、autoScroll=true（原行为）
  //  - end 已贴近末条 → autoScroll=true（贴底跟随新消息）
  //  - 否则用户停在中间 → 锚到 visibleRange.start、autoScroll=false（恢复停留位置）
  const visibleRange = useSessionVisibleRange(sessionId ?? null);
  const atBottomOnMount = !visibleRange || visibleRange.end >= displayMessages.length - 1;
  const restoreIndex = visibleRange && !atBottomOnMount
    ? Math.min(visibleRange.start, displayMessages.length - 1)
    : displayMessages.length - 1;

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [currentRoundIndex, setCurrentRoundIndex] = useState(0);

  // ===== 锚点模式自动滚动（useMessageAutoScroll）=====
  // 消灭 150px 死区（atBottomThreshold→4），followOutput 回调精确跟随：
  // 流式期间始终贴底（内容向上生长），非流式仅在「跟随态&&贴底」时跟随；
  // 用户主动上滑才停止跟随（handleWheel），内容高度增长不误判为用户离开；
  // 流式结束/内容测量完成后 compensateScroll 补偿贴底。
  const scrollState = useMessageAutoScroll(virtuosoRef, { isStreaming, initialAutoScroll: atBottomOnMount });
  // 注意：scrollToBottom 用组件自身实现（含 scrollActions 引用），不从 hook 解构以避免重复声明
  const { autoScroll, handleAtBottomStateChange, handleWheel, setAutoScroll, compensateScroll, setScrollerRef } = scrollState;

  // 流式结束 / 内容变化后补偿一次贴底（锚点模式核心：测量完成后主动贴底）
  useEffect(() => {
    if (!isStreaming && autoScroll) {
      compensateScroll();
    }
    // 依赖 displayMessages 末尾消息内容长度：流式结束归档后补偿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

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
  }, [conversationRounds, setAutoScroll]);

  const scrollToBottom = useCallback(() => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollTo({
      top: Number.MAX_SAFE_INTEGER,
      behavior: 'smooth',
    });
    setAutoScroll(true);
  }, [setAutoScroll]);

  const scrollToTop = useCallback(() => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollToIndex({
      index: 0,
      align: 'start',
      behavior: 'smooth',
    });
    setAutoScroll(false);
  }, [setAutoScroll]);

  const scrollToMessage = useCallback((index: number) => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollToIndex({
      index,
      align: 'start',
      behavior: 'smooth',
    });
    setAutoScroll(false);
  }, [setAutoScroll]);

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

  // Scroller 包装：向上滚动=用户主动离开，通知锚点模式停止跟随；ref 交给 hook 用于流式补偿观察
  // 注意：react-virtuoso 会给 Scroller 传 ref（内部 scrollerRef）用于测量/滚动，函数组件必须 forwardRef
  // 接收并转发，否则 virtuoso 拿不到 scroller DOM（scrollerRef.current=null → 渲染崩溃）。
  // paddingBottom 由这里承担（原 Footer 120px spacer 下沉为容器 padding），让 align:'end' 贴的是
  // 真实最后一条消息底，而非 Footer 占位——否则消息离视口底始终有 ~120px 空隙。
  const CustomScroller = useMemo(() => {
    const Scroller = forwardRef<HTMLDivElement, ComponentProps<'div'>>(
      ({ onWheel: _ignoredWheel, style, ...props }, ref) => (
        <div
          {...props}
          style={{ ...style, paddingBottom: FOOTER_SPACER_STYLE.height }}
          ref={(node) => {
            // 转发 virtuoso 的 ref（callback ref，可能为 null）
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as MutableRefObject<HTMLDivElement | null>).current = node;
            // 同时挂自己的补偿观察 ref
            setScrollerRef(node);
          }}
          onWheel={handleWheel}
        />
      )
    );
    Scroller.displayName = 'AutoScrollScroller';
    return Scroller;
  }, [handleWheel, setScrollerRef]);

  return (
    <div className="chat-display-root flex-1 overflow-hidden flex flex-col" style={chatDisplayStyle}>
      {/* 消息列表 */}
      <div className="flex-1 min-h-0 relative">
        {/* 灵动岛：顶部居中浮动进度指示器，per-session */}
        <DynamicIsland sessionId={sessionId} />

        <div className="relative h-full">
          <Virtuoso
            ref={virtuosoRef}
            style={{ height: '100%' }}
            data={displayMessages}
            itemContent={(index, item) => {
              return renderChatMessage(item, index, scrollActions, messageActions, collapseMode);
            }}
            components={{
              // 空态用 EmptyPlaceholder 承接，避免 isEmpty 三元分支导致 Virtuoso 整树卸载重建
              EmptyPlaceholder: EmptyState,
              Scroller: CustomScroller,
              Footer: () => (
                <>
                  {/* PENDING 状态：在用户消息下方显示 Polaris 旋转图标 + 轮播文案 */}
                  {/* 底部呼吸间距由 Scroller paddingBottom 承担，不再用 spacer 占位，
                      避免锚点 align:'end' 贴到 Footer 而非最后一条消息 */}
                  {isPending && (
                    <ThinkingOrb isPending={isPending} compact={compact} />
                  )}
                </>
              ),
              ...(LoadEarlierHeader ? { Header: LoadEarlierHeader } : {}),
            }}
            followOutput={scrollState.followOutput}
            atBottomStateChange={handleAtBottomStateChange}
            atBottomThreshold={AUTO_SCROLL_THRESHOLD}
            rangeChanged={handleRangeChange}
            startReached={hasEarlier ? handleLoadEarlier : undefined}
            increaseViewportBy={VIEWPORT_EXTENSION}
            initialTopMostItemIndex={isEmpty ? 0 : restoreIndex}
          />
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

        {/* 对话导航时间线 */}
        {!isEmpty && (
          <ChatNavigator
            variant="timeline"
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
