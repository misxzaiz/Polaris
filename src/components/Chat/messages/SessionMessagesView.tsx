/**
 * SessionMessagesView - 多窗口专用的消息显示组件
 *
 * 直接使用 zustand store 订阅特定 session 的状态，避免复杂的 hook 链
 */

import { memo, useMemo, useRef, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager';
import { useConfigStore } from '@/stores/configStore';
import { renderChatMessage } from './EnhancedChatMessages';
import type { MessageScrollActions, MessageActions } from './EnhancedChatMessages';
import type { ChatMessage, AssistantChatMessage } from '@/types/chat';
import type { ConversationStoreInstance, ConversationState } from '@/stores/conversationStore/types';
import {
  findCurrentRoundIndexForRange,
  getRoundScrollTargetIndex,
  groupConversationRounds,
} from '@/utils/conversationRounds';
import { ThinkingOrb } from '../common/ThinkingOrb';
import { ChatNavigator } from '../session/ChatNavigator';
import { DynamicIsland } from '../dynamic-island';

// 模块级稳定空数组：store 缺失时 getSnapshot 返回 defaultValue，
// 内联 [] 每次渲染新建引用会被 useSyncExternalStore 判定为 snapshot
// 持续变化，触发同步重渲染循环（React error #185）。
const EMPTY_MESSAGES: ChatMessage[] = [];

/** 空状态组件 */
const EmptyState = memo(function EmptyState() {
  const { t } = useTranslation('chat');
  return (
    <div className="h-full flex items-center justify-center text-text-muted">
      <div className="text-center">
        <p className="text-sm">{t('emptyState.startChat')}</p>
      </div>
    </div>
  );
});

interface SessionMessagesViewProps {
  sessionId: string;
  /** 编辑消息回调 */
  onEditMessage?: (messageId: string, content: string) => void;
}

/**
 * 直接订阅 session store 的 hook
 * 关键：当 store 存在时，订阅 store 本身而不是 sessionStoreManager
 */
function useSessionStoreSubscription<T>(
  sessionId: string,
  selector: (state: ConversationState) => T,
  defaultValue: T
): T {
  // 缓存 store 实例，避免频繁查找
  const storeRef = useRef<ConversationStoreInstance | null>(null);
  const cacheRef = useRef<T>(defaultValue);

  // 获取 store 实例
  const getStore = useCallback(() => {
    return sessionStoreManager.getState().stores.get(sessionId);
  }, [sessionId]);

  // 初始化/更新 store ref
  useEffect(() => {
    const store = getStore();
    if (store && storeRef.current !== store) {
      storeRef.current = store;
      cacheRef.current = defaultValue; // store 变化时重置缓存
    }
  }, [getStore, defaultValue]);

  // subscribe 函数：订阅正确的 store
  const subscribe = useCallback((onChange: () => void) => {
    const store = getStore();
    if (store) {
      // 直接订阅 session store
      return store.subscribe(onChange);
    } else {
      // store 不存在时，订阅 sessionStoreManager 等待 store 创建
      return sessionStoreManager.subscribe(onChange);
    }
  }, [getStore]);

  // getSnapshot：获取当前值
  const getSnapshot = useCallback(() => {
    const store = storeRef.current || getStore();
    if (!store) return defaultValue;

    const newValue = selector(store.getState());

    // 引用稳定性检查
    if (cacheRef.current === newValue) {
      return cacheRef.current;
    }

    cacheRef.current = newValue;
    return newValue;
  }, [getStore, selector, defaultValue]);

  const getServerSnapshot = useCallback(() => defaultValue, [defaultValue]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export const SessionMessagesView = memo(function SessionMessagesView({ sessionId, onEditMessage }: SessionMessagesViewProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const autoScrollRef = useRef(true);
  const [currentRoundIndex, setCurrentRoundIndex] = useState(0);
  const collapseMode = useConfigStore((s) => s.config?.chatDisplay?.processBlockCollapse ?? 'auto');

  // 直接订阅特定 session store 的状态
  const messages = useSessionStoreSubscription(
    sessionId,
    useCallback((state) => state.messages, []),
    EMPTY_MESSAGES
  );

  const currentMessage = useSessionStoreSubscription(
    sessionId,
    useCallback((state) => state.currentMessage, []),
    null
  );

  const isStreaming = useSessionStoreSubscription(
    sessionId,
    useCallback((state) => state.isStreaming, []),
    false
  );



  // 合并流式消息到消息列表
  const displayMessages = useMemo(() => {
    if (!currentMessage || !isStreaming) {
      return messages;
    }

    // 检查 currentMessage 是否已在 messages 中
    const existingIndex = messages.findIndex((m: ChatMessage) => m.id === currentMessage.id);

    if (existingIndex >= 0) {
      // 更新已存在的消息
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
      return updated;
    } else {
      // 添加到末尾
      return [...messages, {
        id: currentMessage.id,
        type: 'assistant' as const,
        engineId: currentMessage.engineId,
        blocks: currentMessage.blocks,
        timestamp: new Date().toISOString(),
        isStreaming: true,
      }];
    }
  }, [messages, currentMessage, isStreaming]);

  const isEmpty = displayMessages.length === 0;
  // PENDING 状态：已发送消息、正在等待首 token
  const isPending = isStreaming && !currentMessage;

  // 对话轮次分组
  const conversationRounds = useMemo(() => {
    return groupConversationRounds(displayMessages);
  }, [displayMessages]);

  // 可见范围变化时更新当前轮次
  const handleRangeChange = useCallback((range: { startIndex: number; endIndex: number }) => {
    const target = findCurrentRoundIndexForRange(conversationRounds, range.startIndex, range.endIndex);
    if (target >= 0) setCurrentRoundIndex(target);
  }, [conversationRounds]);

  // 滚动到指定轮次
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

    autoScrollRef.current = false;
    setCurrentRoundIndex(roundIndex);
  }, [conversationRounds]);

  // 自动滚动到底部
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    autoScrollRef.current = atBottom;
  }, []);

  // 滚动到指定消息
  const scrollToMessage = useCallback((index: number) => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollToIndex({
      index,
      align: 'start',
      behavior: 'smooth',
    });
  }, []);

  // 滚动到顶部
  const scrollToTop = useCallback(() => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollToIndex({
      index: 0,
      align: 'start',
      behavior: 'smooth',
    });
  }, []);

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollTo({
      top: Number.MAX_SAFE_INTEGER,
      behavior: 'smooth',
    });
  }, []);

  // 消息滚动操作集合
  const scrollActions = useMemo<MessageScrollActions>(() => ({
    scrollToMessage,
    scrollToTop,
    scrollToBottom,
  }), [scrollToMessage, scrollToTop, scrollToBottom]);

  // streaming 时自动滚动到底部
  useEffect(() => {
    if (isStreaming && autoScrollRef.current && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({
        index: displayMessages.length - 1,
        align: 'end',
        behavior: 'smooth',
      });
    }
  }, [isStreaming, displayMessages.length]);

  // 消息操作
  const messageActions = useMemo<MessageActions | undefined>(() => {
    return onEditMessage ? { onEdit: onEditMessage } : undefined;
  }, [onEditMessage]);

  // 灵动岛定位跳转：blockIndex 是 currentMessage.blocks 中的索引，
  // 滚动到该消息后用 DOM querySelector 定位块并 ring 高亮 1.8s。
  const handleIslandLocate = useCallback((blockIndex: number) => {
    if (!currentMessage) return;
    const msgIndex = displayMessages.findIndex(m => m.id === currentMessage.id);
    if (msgIndex < 0 || !virtuosoRef.current) return;

    virtuosoRef.current.scrollToIndex({
      index: msgIndex,
      align: 'start',
      behavior: 'smooth',
    });
    autoScrollRef.current = false;

    // 延迟一帧等消息进入视口后定位块并高亮
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(
          `[data-block-index="${blockIndex}"]`
        );
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('island-locate-highlight');
        setTimeout(() => {
          el.classList.remove('island-locate-highlight');
        }, 1800);
      });
    });
  }, [currentMessage, displayMessages]);

  return (
    <div className="h-full w-full relative">
      {/* 灵动岛：顶部居中浮动进度指示器，per-session（多窗口各自独立） */}
      <DynamicIsland sessionId={sessionId} onLocate={handleIslandLocate} />

      {isEmpty ? (
        <EmptyState />
      ) : (
        <Virtuoso
          ref={virtuosoRef}
          style={{ height: '100%' }}
          data={displayMessages}
          itemContent={(index, item) => {
            return renderChatMessage(item, index, scrollActions, messageActions, collapseMode);
          }}
          components={{
            EmptyPlaceholder: () => null,
            Footer: () => (
              <>
                {/* PENDING 状态：在用户消息下方显示 Polaris 旋转图标 + 轮播文案 */}
                {isPending && (
                  <ThinkingOrb isPending={isPending} compact={true} />
                )}
                <div style={{ height: '80px' }} />
              </>
            ),
          }}
          followOutput={autoScrollRef.current ? (isStreaming ? true : 'smooth') : false}
          atBottomStateChange={handleAtBottomStateChange}
          atBottomThreshold={100}
          rangeChanged={handleRangeChange}
          increaseViewportBy={{ top: 50, bottom: 100 }}
          initialTopMostItemIndex={displayMessages.length - 1}
        />
      )}

      {/* 对话导航时间线 */}
      {!isEmpty && conversationRounds.length > 1 && (
        <ChatNavigator
          variant="timeline"
          rounds={conversationRounds}
          currentRoundIndex={currentRoundIndex}
          onScrollToBottom={scrollToBottom}
          onScrollToRound={scrollToRound}
        />
      )}


    </div>
  );
});
